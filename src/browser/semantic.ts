import type { CDPSession, Page } from "playwright";

export interface SemanticElement {
  ref: string;
  role: string;
  name: string;
  disabled: boolean;
  backendNodeId: number;
  expanded?: boolean;
  selected?: boolean;
  filled?: boolean;
  nativeSelect?: boolean;
  value?: string;
  visibleText?: string;
  options?: Array<{ label: string; disabled: boolean }>;
}

export interface SemanticRead {
  title: string;
  url: string;
  humanVerification: boolean;
  elements: SemanticElement[];
}

const USEFUL = new Set([
  "button",
  "disclosuretriangle",
  "checkbox",
  "combobox",
  "heading",
  "link",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

const CHALLENGE =
  /^(?:verify (?:you are human|your identity)|confirm (?:you are human|your identity)|complete (?:the )?(?:captcha|verification)|enter (?:the )?(?:one[- ]time|verification) code|insan olduğunuzu doğrulayın|kimliğinizi doğrulayın|doğrulama kodunu girin|captcha|mfa|2fa|i[’']?m not a robot|ben robot değilim)(?:[.!?\s]*|[,:] .*| by .*| to continue)$/iu;

interface AxNode {
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
}

interface DomNode {
  nodeName?: string;
  nodeValue?: string;
  attributes?: string[];
  children?: DomNode[];
}

/** Accessibility tree in the OpenMaus semantic snapshot shape. */
export async function readSemantic(page: Page): Promise<SemanticRead> {
  const title = (await page.title()).replace(/\s+/g, " ").trim().slice(0, 200);
  const url = page.url();
  return withCdp(page, async (client) => {
    await client.send("Accessibility.enable").catch(() => undefined);
    await client.send("DOM.enable").catch(() => undefined);
    const document = (await client.send("DOM.getDocument", { depth: 0 })) as { root?: { nodeId?: number } };
    const tree = (await client.send("Accessibility.getFullAXTree", { depth: 14 })) as { nodes?: AxNode[] };
    const nodes = tree.nodes ?? [];
    const humanVerification = await pageNeedsPerson(client, document.root?.nodeId, nodes);
    if (humanVerification) return { title, url, humanVerification: true, elements: [] };
    const elements: SemanticElement[] = [];
    for (const node of nodes) {
      const role = String(node.role?.value ?? "").toLowerCase();
      const name = String(node.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
      const backend = Number(node.backendDOMNodeId ?? 0);
      if (!backend || node.ignored || !USEFUL.has(role) || (!name && role !== "textbox" && role !== "searchbox")) continue;
      const element: SemanticElement = {
        ref: `b${backend}`,
        role,
        name: name || "unnamed",
        disabled: node.properties?.some((property) => property.name === "disabled" && property.value?.value === true) ?? false,
        backendNodeId: backend,
      };
      for (const key of ["expanded", "selected"] as const) {
        const value = node.properties?.find((property) => property.name === key)?.value?.value;
        if (typeof value === "boolean") element[key] = value;
      }
      if (role === "textbox" || role === "searchbox") element.filled = Boolean(String(node.value?.value ?? "").trim());
      if (role === "combobox") await describeCombobox(client, node, element);
      elements.push(element);
      if (elements.length >= 250) break;
    }
    return { title, url, humanVerification: false, elements };
  });
}

export function formatSemanticSnapshot(id: number, read: SemanticRead): string {
  const lines = [
    `Semantic browser snapshot #${id} — ${read.title}: ${read.url}`,
    `Pass snapshotId=${id} with every browser_click/browser_fill.`,
  ];
  for (const element of read.elements) {
    const role = element.disabled ? `${element.role} disabled` : element.role;
    lines.push(`- [${element.ref}] ${role}: ${element.name}`);
  }
  for (const element of read.elements) {
    if (element.nativeSelect) {
      lines.push(
        `Select state [${element.ref}]: ${JSON.stringify({ value: element.value ?? "", options: element.options ?? [], nativeSelect: true })}`,
      );
    }
    if ((element.role === "textbox" || element.role === "searchbox") && typeof element.filled === "boolean") {
      lines.push(`Input state [${element.ref}]: ${JSON.stringify({ filled: element.filled })}`);
    }
    if (element.role === "combobox" && !element.nativeSelect && element.visibleText) {
      lines.push(`Combobox state [${element.ref}]: ${JSON.stringify({ visibleText: element.visibleText })}`);
    }
    if (typeof element.expanded === "boolean" || typeof element.selected === "boolean") {
      const info: { expanded?: boolean; selected?: boolean } = {};
      if (typeof element.expanded === "boolean") info.expanded = element.expanded;
      if (typeof element.selected === "boolean") info.selected = element.selected;
      lines.push(`Information state [${element.ref}]: ${JSON.stringify(info)}`);
    }
  }
  return lines.join("\n");
}

export async function clickBackend(page: Page, backendNodeId: number): Promise<void> {
  const point = await withCdp(page, async (client) => {
    await client.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    const boxed = (await client.send("DOM.getBoxModel", { backendNodeId })) as { model?: { border?: number[]; content?: number[] } };
    const quad = boxed.model?.border ?? boxed.model?.content;
    if (!quad || quad.length < 8) throw new Error("element is not visible; take a new snapshot");
    const layout = (await client.send("Page.getLayoutMetrics")) as {
      cssLayoutViewport?: { pageX?: number; pageY?: number };
      visualViewport?: { pageX?: number; pageY?: number };
    };
    const originX = layout.cssLayoutViewport?.pageX ?? layout.visualViewport?.pageX ?? 0;
    const originY = layout.cssLayoutViewport?.pageY ?? layout.visualViewport?.pageY ?? 0;
    return {
      x: ((quad[0] ?? 0) + (quad[2] ?? 0) + (quad[4] ?? 0) + (quad[6] ?? 0)) / 4 - originX,
      y: ((quad[1] ?? 0) + (quad[3] ?? 0) + (quad[5] ?? 0) + (quad[7] ?? 0)) / 4 - originY,
    };
  });
  const previous = page.url();
  const navigated = page.waitForURL((url) => url.toString() !== previous, { waitUntil: "domcontentloaded", timeout: 400 }).catch(() => undefined);
  await page.mouse.click(point.x, point.y);
  await navigated;
}

export async function fillBackend(page: Page, backendNodeId: number, text: string): Promise<void> {
  await withCdp(page, async (client) => {
    const described = (await client.send("DOM.describeNode", { backendNodeId, depth: 0 })) as { node?: DomNode };
    const attrs = attrMap(described.node);
    const type = (attrs.type ?? "").toLowerCase();
    const autocomplete = (attrs.autocomplete ?? "").toLowerCase();
    if (type === "password" || /(?:current-password|new-password|one-time-code|cc-number|cc-csc)/.test(autocomplete)) {
      throw new Error("USER_TAKEOVER_REQUIRED: sensitive field");
    }
    await client.send("DOM.focus", { backendNodeId });
  });
  const selectAll = process.platform === "darwin" ? "Meta+A" : "Control+A";
  await page.keyboard.press(selectAll);
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(text);
}

/** Commits one exact enabled option. The picker key sequence is unreliable headless, so the grounded option is set and a change event is fired. */
export async function selectBackend(page: Page, backendNodeId: number, option: string): Promise<void> {
  await withCdp(page, async (client) => {
    const described = (await client.send("DOM.describeNode", { backendNodeId, depth: 3 })) as { node?: DomNode };
    const node = described.node;
    const attrs = attrMap(node);
    if (!node || node.nodeName !== "SELECT" || "multiple" in attrs || "disabled" in attrs) {
      throw new Error("unsupported or disabled select");
    }
    const options = nativeOptions(node).filter((item) => !item.disabled);
    if (options.length > 50 || options.filter((item) => item.label === option).length !== 1) {
      throw new Error("missing or ambiguous option");
    }
    const resolved = (await client.send("DOM.resolveNode", { backendNodeId })) as { object?: { objectId?: string } };
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("unsupported or disabled select");
    await client.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(label) {
        const matches = [...this.options].filter((item) => !item.disabled && item.label === label);
        if (matches.length !== 1) throw new Error("missing or ambiguous option");
        this.value = matches[0].value;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
      }`,
      arguments: [{ value: option }],
    });
  });
}

async function describeCombobox(client: CDPSession, node: AxNode, element: SemanticElement): Promise<void> {
  const backend = element.backendNodeId;
  const described = (await client.send("DOM.describeNode", { backendNodeId: backend, depth: 3 }).catch(() => ({}))) as { node?: DomNode };
  if (described.node?.nodeName === "SELECT" && !Object.hasOwn(attrMap(described.node), "multiple")) {
    const options = nativeOptions(described.node);
    if (options.length <= 50) {
      element.nativeSelect = true;
      element.value = String(node.value?.value ?? "");
      element.options = options;
    }
    return;
  }
  const markup = (await client.send("DOM.getOuterHTML", { backendNodeId: backend }).catch(() => ({ outerHTML: "" }))) as { outerHTML?: string };
  const text = (markup.outerHTML ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
  if (text) element.visibleText = text;
}

async function pageNeedsPerson(client: CDPSession, documentNodeId: number | undefined, nodes: AxNode[]): Promise<boolean> {
  if (documentNodeId) {
    const found = (await client.send("DOM.querySelectorAll", {
      nodeId: documentNodeId,
      selector:
        'input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[autocomplete="new-password"], iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"][src*="challenge"], iframe[src*="challenges.cloudflare.com"]',
    }).catch(() => ({ nodeIds: [] }))) as { nodeIds?: number[] };
    for (const nodeId of found.nodeIds ?? []) {
      const box = (await client.send("DOM.getBoxModel", { nodeId }).catch(() => null)) as { model?: { width?: number; height?: number } } | null;
      if ((box?.model?.width ?? 0) > 1 && (box?.model?.height ?? 0) > 1) return true;
    }
  }
  return nodes.some((node) => {
    if (node.ignored) return false;
    const role = String(node.role?.value ?? "").toLowerCase();
    const name = String(node.name?.value ?? "").slice(0, 200);
    return /^(?:heading|statictext|textbox|button|checkbox)$/.test(role) && CHALLENGE.test(name);
  });
}

function nativeOptions(node: DomNode): Array<{ label: string; disabled: boolean }> {
  const options: Array<{ label: string; disabled: boolean }> = [];
  const walk = (current: DomNode) => {
    if (current.nodeName === "OPTION") {
      const attrs = attrMap(current);
      const label = (attrs.label || textOf(current) || attrs.value || "").replace(/\s+/g, " ").trim().slice(0, 180);
      if (label) options.push({ label, disabled: Object.hasOwn(attrs, "disabled") });
    }
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return options;
}

function textOf(node: DomNode): string {
  if (node.nodeName === "#text") return node.nodeValue ?? "";
  return (node.children ?? []).map((child) => textOf(child)).join("");
}

function attrMap(node: DomNode | undefined): Record<string, string> {
  const raw = node?.attributes ?? [];
  const out: Record<string, string> = {};
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index];
    if (!key) continue;
    out[key.toLowerCase()] = raw[index + 1] ?? "";
  }
  return out;
}

async function withCdp<T>(page: Page, run: (client: CDPSession) => Promise<T>): Promise<T> {
  const client = await page.context().newCDPSession(page);
  try {
    return await run(client);
  } finally {
    await client.detach().catch(() => undefined);
  }
}

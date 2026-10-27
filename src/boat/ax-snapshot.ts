import { snapshotHostAllowed } from "../browser/navigation-policy.js";

/** Roles the model can click or fill. Adapted from OpenMausBot's AX filter. */
const USEFUL = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "tab",
  "menuitem",
  "switch",
]);

const TAKEOVER = /\b(captcha|mfa|2fa|one[- ]time|password|passkey|verify you are human|doğrulama kodu|şifre)\b/i;

export interface AxElement {
  ref: string;
  role: string;
  name: string;
  disabled: boolean;
  filled?: boolean;
}

export interface AxSnapshot {
  snapshotId: number;
  targetId: string;
  url: string;
  title: string;
  elements: AxElement[];
}

export interface AxNode {
  role?: string;
  name?: string;
  backendNodeId?: number;
  disabled?: boolean;
  ignored?: boolean;
  /** Length only. The characters are not kept. */
  valueLength?: number;
}

/** One interactive node becomes `b{backendNodeId}`. The field value stays out. */
export function elementFromNode(node: AxNode): AxElement | null {
  if (node.ignored) return null;
  const role = (node.role ?? "").toLowerCase();
  const backend = node.backendNodeId ?? 0;
  if (!USEFUL.has(role) || !Number.isInteger(backend) || backend <= 0) return null;
  const name = (node.name ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
  if (!name && role !== "textbox" && role !== "searchbox") return null;
  const element: AxElement = { ref: `b${backend}`, role, name: name || "unnamed", disabled: node.disabled === true };
  if (role === "textbox" || role === "searchbox") element.filled = (node.valueLength ?? 0) > 0;
  return element;
}

export function takeoverRequired(names: readonly string[]): boolean {
  return names.some((name) => TAKEOVER.test(name));
}

export function assertSnapshotRef(
  current: { snapshotId: number; targetId: string; refs: readonly string[] },
  request: { snapshotId: number; targetId?: string; ref: string },
): void {
  if (!/^b\d+$/.test(request.ref) || request.snapshotId !== current.snapshotId || !current.refs.includes(request.ref)) {
    throw new Error("that snapshot is stale — call browser_snapshot");
  }
  if (request.targetId && request.targetId !== current.targetId) {
    throw new Error("that snapshot is stale — call browser_snapshot");
  }
}

/** Exact URL, or the same origin with only a trailing slash difference, counts. A public cross-origin hop does not. */
export function navigationMatches(expectedUrl: string, actualUrl: string): "exact" | "same-origin" | "redirect" | "blocked" {
  let expected: URL;
  let actual: URL;
  try {
    expected = new URL(expectedUrl);
    actual = new URL(actualUrl);
  } catch {
    return "blocked";
  }
  if (!snapshotHostAllowed(actual.toString())) return "blocked";
  const strip = (url: URL) => url.toString().replace(/\/$/, "");
  if (strip(expected) === strip(actual)) return "exact";
  if (expected.hostname === actual.hostname && expected.protocol === "http:" && actual.protocol === "https:") return "same-origin";
  if (expected.origin === actual.origin) return "same-origin";
  return "redirect";
}

const OPEN = /(?:^|[\s"'’])(a[cç]|open|git|go\s+to|navigate)(?=$|[\s.,!?"'’])/iu;
const FOLLOW = /\b(giriş|login|tıkla|click|doldur|fill|yaz|type|ara|search|kaydet|save)\b/iu;

/** A single "open this site" request. Multi-step text stays with the agent. */
export function directOpenIntent(text: string): { url: string } | null {
  if (!OPEN.test(text) || FOLLOW.test(text)) return null;
  const explicit = text.match(/https?:\/\/[^\s<>()]+/iu)?.[0]?.replace(/[.,!?]+$/, "");
  if (!explicit) return null;
  try {
    const url = new URL(explicit);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { url: url.toString() };
  } catch {
    return null;
  }
}

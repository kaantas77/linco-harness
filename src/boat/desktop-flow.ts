import type { DesktopObservation } from "./client.js";
import type { DriverSchema } from "./driver-schema.js";
import { inspectPng } from "./label-png.js";

export interface DriverCaller {
  call(tool: string, args: Record<string, unknown>): Promise<DesktopObservation>;
  schema(name: string): DriverSchema | undefined;
}

export type BrowserFailure = "wrong-window" | "not-loaded" | "connection";

export interface FlowResult {
  ok: boolean;
  kind: "ok" | BrowserFailure | "unreliable";
  detail: string;
  calls: string[];
  retries: number;
  png?: Buffer;
  width?: number;
  height?: number;
  dark?: number;
  decoded?: boolean;
  tree?: string;
}

const BROWSER_FALLBACK = ["Google Chrome", "google-chrome", "Chromium", "chromium"];
const EDITOR_FALLBACK = ["Text Editor", "gedit", "gnome-text-editor", "xed", "mousepad"];
const VIEWER_FALLBACK = ["Image Viewer", "eog", "feh", "loupe"];

/** Opens the URL and returns ok only when the accessibility or browser state contains the expected title. */
export async function openVerifiedPage(driver: DriverCaller, url: string, expect: RegExp): Promise<FlowResult> {
  const calls: string[] = [];
  let retries = 0;
  try {
    await run(driver, calls, "tools/list", {});
    const catalog = await catalogOf(driver, calls);
    let ids = await windowFor(driver, calls, {}, /chrome|chromium/i);
    let launched = "";
    if (!ids.pid || !ids.windowId) {
      const attempt = await launchFirst(driver, calls, pickApps(catalog, /chrome|chromium/i, BROWSER_FALLBACK));
      launched = attempt.detail;
      ids = await windowFor(driver, calls, attempt.ids, /chrome|chromium/i);
    }
    if (!ids.pid || !ids.windowId) return done(false, "wrong-window", clip(`${launched || "browser window was not found"} catalog ${catalog}`), calls, retries);
    await run(driver, calls, "bring_to_front", { pid: ids.pid, window_id: ids.windowId });
    let bound = await run(driver, calls, "get_browser_state", { pid: ids.pid, window_id: ids.windowId });
    if (/browser_requires_setup|requires setup/i.test(bound.text) && driver.schema("browser_prepare")) {
      await run(driver, calls, "browser_prepare", { pid: ids.pid, window_id: ids.windowId, allow_launch: true });
      bound = await run(driver, calls, "get_browser_state", { pid: ids.pid, window_id: ids.windowId });
    }
    const early = judge(bound.text, expect, url);
    if (early === "connection") return done(false, "connection", clip(bound.text), calls, retries);
    ids = { ...ids, ...readIds(bound.text) };
    if (!ids.targetId || !ids.tabId) {
      if (/browser_consent_required|browser_requires_setup/i.test(bound.text)) {
        const prepared = await prepareBrowser(driver, calls, ids);
        if (prepared) {
          ids = { ...ids, ...readIds(prepared) };
          bound = { ...bound, text: prepared };
        }
      }
    }
    if (!ids.targetId || !ids.tabId) return openByKeyboard(driver, calls, ids, url, expect, retries, bound.text);
    const navigated = await run(driver, calls, "browser_navigate", { url, target_id: ids.targetId, tab_id: ids.tabId });
    const navKind = judge(navigated.text, expect, url);
    if (navKind === "connection") return done(false, "connection", clip(navigated.text), calls, retries);
    await sleep(1500);
    let after = await run(driver, calls, "get_browser_state", { pid: ids.pid, window_id: ids.windowId, target_id: ids.targetId, tab_id: ids.tabId });
    let kind = judge(after.text, expect, url);
    if (kind !== "ok") {
      retries += 1;
      await sleep(1500);
      after = await run(driver, calls, "get_browser_state", {
        pid: ids.pid,
        window_id: ids.windowId,
        target_id: readIds(after.text).targetId ?? ids.targetId,
        tab_id: readIds(after.text).tabId ?? ids.tabId,
      });
      kind = judge(after.text, expect, url);
    }
    if (kind !== "ok") return done(false, kind, clip(after.text), calls, retries);
    return done(true, "ok", clip(after.text), calls, retries);
  } catch (error) {
    return done(false, failureKind(error), clip(message(error)), calls, retries);
  }
}

/** Clicks the editor, types, and asks the editor to save. The caller reads the file with a separate tool. */
export async function typeIntoEditor(driver: DriverCaller, filePath: string, text: string): Promise<FlowResult> {
  const calls: string[] = [];
  let retries = 0;
  try {
    await run(driver, calls, "tools/list", {});
    const catalog = await catalogOf(driver, calls);
    const editorPattern = /gedit|text editor|xed|mousepad|kate|pluma|typed\.txt|nano|terminal/i;
    let launched = "";
    try {
      await run(driver, calls, "launch_app", {
        name: "gnome-terminal",
        launch_path: "/usr/bin/gnome-terminal",
        additional_arguments: ["--", "nano", filePath],
      });
      await sleep(1000);
    } catch (error) {
      launched = message(error);
    }
    let ids = await windowFor(driver, calls, {}, editorPattern);
    if (!ids.pid || !ids.windowId) {
      const attempt = await launchFirst(driver, calls, pickApps(catalog, editorPattern, EDITOR_FALLBACK), [filePath]);
      launched = attempt.detail;
      ids = await windowFor(driver, calls, attempt.ids, editorPattern);
    }
    if (!ids.pid || !ids.windowId) return done(false, "wrong-window", clip(`${launched || "text editor was not found"} catalog ${catalog}`), calls, retries);
    await run(driver, calls, "bring_to_front", { pid: ids.pid, window_id: ids.windowId });
    const state = await run(driver, calls, "get_window_state", { pid: ids.pid, window_id: ids.windowId, include_screenshot: false });
    const center = readCenter(state.text) ?? { x: 640, y: 420 };
    const token = readToken(state.text);
    await run(driver, calls, "click", { pid: ids.pid, window_id: ids.windowId, x: center.x, y: center.y, element_token: token, delivery_mode: "foreground" });
    await run(driver, calls, "type_text", {
      pid: ids.pid,
      window_id: ids.windowId,
      x: center.x,
      y: center.y,
      text,
      element_token: token,
      delivery_mode: "foreground",
    });
    await save(driver, calls, ids, /nano|terminal/i.test(`${state.text} ${launched}`));
    const saved = calls.includes("hotkey") || calls.includes("press_key");
    return {
      ok: calls.includes("click") && calls.includes("type_text") && saved,
      kind: saved ? "ok" : "connection",
      detail: saved ? clip(state.text) : "save shortcut is not in the driver catalog",
      calls,
      retries,
    };
  } catch (error) {
    return done(false, failureKind(error), clip(message(error)), calls, retries);
  }
}

/** Screenshots the image-viewer window. A full desktop or a blank PNG is not a successful capture. */
export async function captureViewer(driver: DriverCaller, hint = "shot.png", filePath?: string): Promise<FlowResult> {
  const calls: string[] = [];
  let retries = 0;
  try {
    await run(driver, calls, "tools/list", {});
    if (filePath) {
      const catalog = await catalogOf(driver, calls);
      const fileUrl = filePath.startsWith("/") ? `file://${filePath}` : filePath;
      await launchFirst(driver, calls, pickApps(catalog, /eog|image viewer|feh|loupe|gwenview|chrom/i, VIEWER_FALLBACK), [filePath, fileUrl]);
      await sleep(1500);
    }
    const listed = await run(driver, calls, "list_windows", {});
    const ids = readViewer(listed.text, hint) ?? readViewer((await run(driver, calls, "get_desktop_state", {})).text, hint);
    if (!ids?.pid || !ids.windowId) return done(false, "wrong-window", `image viewer window was not found: ${clip(listed.text)}`, calls, retries);
    await run(driver, calls, "bring_to_front", { pid: ids.pid, window_id: ids.windowId });
    let shot = await run(driver, calls, "get_window_state", { pid: ids.pid, window_id: ids.windowId, include_screenshot: true });
    let png = imageBuffer(shot);
    let inspection = png ? inspectPng(png) : undefined;
    if (png && inspection && inspection.width >= 1800 && driver.schema("zoom")) {
      retries += 1;
      const box = readBox(shot.text) ?? { x1: 80, y1: 80, x2: 900, y2: 500 };
      await run(driver, calls, "zoom", { pid: ids.pid, window_id: ids.windowId, ...box });
      shot = await run(driver, calls, "get_window_state", { pid: ids.pid, window_id: ids.windowId, include_screenshot: true });
      png = imageBuffer(shot);
      inspection = png ? inspectPng(png) : undefined;
    }
    if (!png || !inspection?.png || !inspection.decoded) return { ...done(false, "unreliable", "screenshot was not a readable png of the viewer window", calls, retries), tree: shot.text };
    if (inspection.dark < 20) return { ...done(false, "unreliable", `png ${inspection.width}x${inspection.height} has no ink`, calls, retries), tree: shot.text };
    return {
      ok: true,
      kind: "ok",
      detail: `png ${inspection.width}x${inspection.height} dark ${inspection.dark} decoded ${inspection.decoded}`,
      calls,
      retries,
      png,
      width: inspection.width,
      height: inspection.height,
      dark: inspection.dark,
      decoded: inspection.decoded,
      tree: shot.text,
    };
  } catch (error) {
    return done(false, failureKind(error), clip(message(error)), calls, retries);
  }
}

export function readAppWindow(text: string, pattern: RegExp): { pid?: number; windowId?: number } | undefined {
  let found: { pid?: number; windowId?: number } | undefined;
  const visit = (value: unknown, inheritedPid?: number) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedPid);
      return;
    }
    const record = value as Record<string, unknown>;
    const pid = typeof record.pid === "number" ? record.pid : inheritedPid;
    const windowId = numberField(record.window_id ?? record.windowId);
    const label = `${record.title ?? ""} ${record.name ?? ""} ${record.app ?? ""} ${record.application ?? ""}`;
    if (!found && (pid || windowId) && pattern.test(label)) found = { pid, windowId };
    for (const child of Object.values(record)) visit(child, pid);
  };
  for (const candidate of jsonObjects(text)) visit(candidate);
  return found;
}

export function readIds(text: string): { pid?: number; windowId?: number; targetId?: string; tabId?: string } {
  const found: { pid?: number; windowId?: number; targetId?: string; tabId?: string } = {};
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.pid === "number") found.pid = record.pid;
    const windowId = record.window_id ?? record.windowId;
    if (typeof windowId === "number") found.windowId = windowId;
    if (typeof windowId === "string" && /^\d+$/.test(windowId)) found.windowId = Number(windowId);
    if (typeof record.target_id === "string") found.targetId = record.target_id;
    if (typeof record.tab_id === "string") found.tabId = record.tab_id;
    for (const child of Object.values(record)) visit(child);
  };
  for (const candidate of jsonObjects(text)) visit(candidate);
  const pid = /"pid"\s*:\s*"?(\d+)"?/.exec(text);
  if (pid) found.pid = Number(pid[1]);
  const windowId = /"window_id"\s*:\s*"?(\d+)"?/.exec(text);
  if (windowId) found.windowId = Number(windowId[1]);
  const target = /"target_id"\s*:\s*"([^"]+)"/.exec(text);
  if (target?.[1]) found.targetId = target[1];
  const tab = /"tab_id"\s*:\s*"([^"]+)"/.exec(text);
  if (tab?.[1]) found.tabId = tab[1];
  return found;
}

export function judge(text: string, expect: RegExp, url: string): "ok" | BrowserFailure {
  if (expect.test(text)) return "ok";
  if (/browser_requires_setup|ECONNREFUSED|connection refused|ERR_NAME|ERR_CONNECTION|ERR_TIMED_OUT|websocket|net::|timed out/i.test(text)) {
    return "connection";
  }
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  if ((host && text.includes(host)) || /chrome|chromium/i.test(text)) return "not-loaded";
  return "wrong-window";
}

async function prepareBrowser(
  driver: DriverCaller,
  calls: string[],
  ids: { pid?: number; windowId?: number },
): Promise<string | undefined> {
  if (!driver.schema("browser_prepare")) return undefined;
  try {
    let session = "";
    if (driver.schema("start_session")) {
      const started = await run(driver, calls, "start_session", {});
      session = /"session"\s*:\s*"([^"]+)"/.exec(started.text)?.[1] ?? "";
    }
    const prepared = await run(driver, calls, "browser_prepare", {
      pid: ids.pid,
      window_id: ids.windowId,
      ...(session ? { session } : {}),
      strategy: { kind: "existing_profile" },
    });
    return prepared.text;
  } catch (error) {
    return message(error);
  }
}

async function openByKeyboard(
  driver: DriverCaller,
  calls: string[],
  ids: { pid?: number; windowId?: number },
  url: string,
  expect: RegExp,
  retries: number,
  prior: string,
): Promise<FlowResult> {
  try {
    const listed = await run(driver, calls, "list_windows", {});
    const browser = readWindows(listed.text).find((window) => /chrom/i.test(window.title) && window.pid && window.width && window.height && window.x !== undefined && window.y !== undefined);
    if (browser?.pid && browser.width && browser.height && browser.x !== undefined && browser.y !== undefined) {
      await run(driver, calls, "click", {
        pid: browser.pid,
        window_id: browser.windowId,
        x: browser.x + Math.floor(browser.width / 2),
        y: browser.y + 72,
        delivery_mode: "foreground",
      });
    }
    await run(driver, calls, "hotkey", { pid: ids.pid, window_id: ids.windowId, keys: ["ctrl", "l"], key: "ctrl+l", delivery_mode: "foreground" });
    await run(driver, calls, "type_text", { pid: ids.pid, window_id: ids.windowId, text: url, delivery_mode: "foreground" });
    await run(driver, calls, "press_key", { pid: ids.pid, window_id: ids.windowId, key: "Return", delivery_mode: "foreground" });
    await sleep(2000);
    const confirm = async () => {
      const listed = await run(driver, calls, "list_windows", {});
      const titled = readWindows(listed.text).some((window) => expect.test(window.title));
      const tree = await run(driver, calls, "get_accessibility_tree", { pid: ids.pid, window_id: ids.windowId });
      return { titled, text: `${listed.text}\n${tree.text}` };
    };
    let seen = await confirm();
    if (!seen.titled && !expect.test(seen.text)) {
      retries += 1;
      await sleep(1500);
      seen = await confirm();
    }
    if (seen.titled || expect.test(seen.text)) return done(true, "ok", clip(seen.text), calls, retries);
    return done(false, "not-loaded", clip(`${prior} ${seen.text}`), calls, retries);
  } catch (error) {
    return done(false, failureKind(error), clip(`${prior} ${message(error)}`), calls, retries);
  }
}

function launchBag(app: AppChoice, files?: string[]): Record<string, unknown> {
  const urls = files?.filter((file) => /^https?:|^file:/.test(file));
  const args = files?.filter((file) => !/^https?:|^file:/.test(file));
  return {
    name: app.name,
    launch_path: app.launchPath,
    ...(args && args.length > 0 ? { additional_arguments: args } : {}),
    ...(urls && urls.length > 0 ? { urls } : {}),
  };
}

async function catalogOf(driver: DriverCaller, calls: string[]): Promise<string> {
  try {
    return (await run(driver, calls, "list_apps", {})).text;
  } catch (error) {
    return message(error);
  }
}

async function launchFirst(
  driver: DriverCaller,
  calls: string[],
  apps: AppChoice[],
  files?: string[],
): Promise<{ ids: { pid?: number; windowId?: number }; detail: string }> {
  let detail = "no matching app";
  for (const app of apps) {
    try {
      const observation = await run(driver, calls, "launch_app", launchBag(app, files));
      return { ids: readIds(observation.text), detail: observation.text };
    } catch (error) {
      detail = message(error);
    }
  }
  return { ids: {}, detail };
}

async function windowFor(
  driver: DriverCaller,
  calls: string[],
  ids: { pid?: number; windowId?: number; targetId?: string; tabId?: string },
  pattern: RegExp,
): Promise<{ pid?: number; windowId?: number; targetId?: string; tabId?: string }> {
  if (ids.pid && ids.windowId) return ids;
  const listed = await run(driver, calls, "list_windows", ids.pid ? { pid: ids.pid } : {});
  const fromLine = readWindows(listed.text).find((window) => window.pid && window.windowId && pattern.test(window.title));
  if (fromLine?.pid && fromLine.windowId) return { ...ids, pid: fromLine.pid, windowId: fromLine.windowId };
  const found = readAppWindow(listed.text, pattern) ?? readIds(listed.text);
  return { ...ids, pid: ids.pid ?? found.pid, windowId: ids.windowId ?? found.windowId };
}

export interface AppChoice {
  name: string;
  launchPath?: string;
}

export function readWindows(text: string): Array<{ pid?: number; windowId: number; title: string; x?: number; y?: number; width?: number; height?: number }> {
  const found: Array<{ pid?: number; windowId: number; title: string; x?: number; y?: number; width?: number; height?: number }> = [];
  const pattern = /\[xid=(\d+)\]\s+pid=(?:Some\((\d+)\)|(\d+)|None)\s+"([^"]*)"(?:\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+))?/g;
  for (const match of text.matchAll(pattern)) {
    const pid = match[2] ?? match[3];
    const title = match[4] ?? "";
    const width = match[5] ? Number(match[5]) : undefined;
    const height = match[6] ? Number(match[6]) : undefined;
    const x = match[7] ? Number(match[7]) : undefined;
    const y = match[8] ? Number(match[8]) : undefined;
    found.push({
      windowId: Number(match[1]),
      ...(pid ? { pid: Number(pid) } : {}),
      title,
      ...(width !== undefined && height !== undefined && x !== undefined && y !== undefined ? { width, height, x, y } : {}),
    });
  }
  return found;
}

export function pickApps(catalog: string, pattern: RegExp, fallback: string[]): AppChoice[] {
  const names: AppChoice[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    const name = [record.name, record.app, record.title].find((value): value is string => typeof value === "string");
    const launchPath = [record.launch_path, record.launchPath].find((value): value is string => typeof value === "string");
    if (name || launchPath) names.push({ name: name ?? launchPath ?? "", launchPath });
    for (const child of Object.values(record)) visit(child);
  };
  for (const candidate of jsonObjects(catalog)) visit(candidate);
  for (const line of catalog.split("\n")) {
    const launchPath = line.match(/(\/(?:usr|opt|snap)\/[^\s"',]+)/)?.[1];
    const quoted = line.match(/"([^"]+)"/)?.[1];
    if (launchPath || quoted) names.push({ name: quoted ?? launchPath ?? "", launchPath });
  }
  const ranked = names.filter((app) => pattern.test(`${app.name} ${app.launchPath ?? ""}`));
  const merged: AppChoice[] = [...ranked, ...fallback.map((name) => ({ name }))];
  const seen = new Set<string>();
  return merged.filter((app) => {
    const key = app.launchPath ?? app.name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

function readBox(text: string): { x1: number; y1: number; x2: number; y2: number } | undefined {
  const center = readCenter(text);
  const width = /"width"\s*:\s*(\d+)/.exec(text);
  const height = /"height"\s*:\s*(\d+)/.exec(text);
  if (!center || !width || !height) return undefined;
  const halfW = Math.max(40, Math.floor(Number(width[1]) / 4));
  const halfH = Math.max(40, Math.floor(Number(height[1]) / 4));
  return { x1: center.x - halfW, y1: center.y - halfH, x2: center.x + halfW, y2: center.y + halfH };
}

async function save(driver: DriverCaller, calls: string[], ids: { pid?: number; windowId?: number }, nano: boolean): Promise<void> {
  const args = { pid: ids.pid, window_id: ids.windowId, keys: ["ctrl", "s"], key: "ctrl+s", modifiers: ["ctrl"], delivery_mode: "foreground" };
  if (driver.schema("hotkey")) await run(driver, calls, "hotkey", nano ? { ...args, keys: ["ctrl", "o"] } : args);
  if (nano && driver.schema("press_key")) {
    await run(driver, calls, "press_key", { pid: ids.pid, window_id: ids.windowId, key: "Return", delivery_mode: "foreground" });
  } else if (!driver.schema("hotkey") && driver.schema("press_key")) {
    await run(driver, calls, "press_key", args);
  }
}

function readViewer(text: string, hint: string): { pid?: number; windowId?: number } | undefined {
  const fromLine = readWindows(text).find((window) => window.title.includes(hint) && window.pid) ?? readWindows(text).find((window) => /eog|image viewer|feh|loupe|gwenview/i.test(window.title) && window.pid);
  if (fromLine?.pid) return { pid: fromLine.pid, windowId: fromLine.windowId };
  const generic = /eog|image viewer|gwenview|eye of gnome|feh/i;
  let exact: { pid?: number; windowId?: number } | undefined;
  let loose: { pid?: number; windowId?: number } | undefined;
  const visit = (value: unknown, inheritedPid?: number) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedPid);
      return;
    }
    const record = value as Record<string, unknown>;
    const pid = typeof record.pid === "number" ? record.pid : inheritedPid;
    const windowId = numberField(record.window_id ?? record.windowId);
    const label = `${record.title ?? ""} ${record.name ?? ""} ${record.app ?? ""}`;
    if ((pid || windowId) && label.includes(hint)) exact = { pid, windowId };
    else if (!loose && (pid || windowId) && generic.test(label)) loose = { pid, windowId };
    for (const child of Object.values(record)) visit(child, pid);
  };
  for (const candidate of jsonObjects(text)) visit(candidate);
  if (exact || loose) return exact ?? loose;
  if (!text.includes(hint) && !generic.test(text)) return undefined;
  const ids = readIds(text);
  return ids.pid || ids.windowId ? ids : undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function readCenter(text: string): { x: number; y: number } | undefined {
  const x = /"x"\s*:\s*(-?\d+)/.exec(text);
  const y = /"y"\s*:\s*(-?\d+)/.exec(text);
  const width = /"width"\s*:\s*(\d+)/.exec(text);
  const height = /"height"\s*:\s*(\d+)/.exec(text);
  if (!x || !y || !width || !height) return undefined;
  return { x: Number(x[1]) + Math.floor(Number(width[1]) / 2), y: Number(y[1]) + Math.floor(Number(height[1]) / 2) };
}

function readToken(text: string): string | undefined {
  return /"(?:element_token|token)"\s*:\s*"([^"]+)"/.exec(text)?.[1];
}

function imageBuffer(observation: DesktopObservation): Buffer | undefined {
  if (!observation.image?.data) return undefined;
  return Buffer.from(observation.image.data, "base64");
}

async function run(driver: DriverCaller, calls: string[], tool: string, args: Record<string, unknown>): Promise<DesktopObservation> {
  calls.push(tool);
  return driver.call(tool, args);
}

function done(ok: boolean, kind: FlowResult["kind"], detail: string, calls: string[], retries: number): FlowResult {
  return { ok, kind, detail, calls, retries };
}

function failureKind(error: unknown): BrowserFailure {
  const text = message(error);
  if (/missing /.test(text) || /did not answer|timed out|connection/i.test(text)) return "connection";
  if (/window/i.test(text)) return "wrong-window";
  return "connection";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonObjects(text: string): unknown[] {
  const found: unknown[] = [];
  try {
    found.push(JSON.parse(text));
  } catch {
    /* the driver often wraps JSON in a sentence */
  }
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (match) {
    try {
      found.push(JSON.parse(match[0]));
    } catch {
      /* ignore a partial object */
    }
  }
  return found;
}

function clip(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

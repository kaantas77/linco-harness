export type ContractKind = "browser-open" | "browser-click" | "browser-form" | "desktop-type" | "code-run" | "subagents";

/** Derived from the user text. The model cannot replace it. Chat requests stay unset. */
export interface ExecutionContract {
  kind: ContractKind;
  url?: string;
  token?: string;
  file?: string;
  expectUrlIncludes?: string;
}

export interface ToolUse {
  name: string;
  isError: boolean;
}

export interface EvidenceView {
  tools: ToolUse[];
  pageUrl?: string;
  pageTitle?: string;
  pageText?: string;
  fileText?: string;
  fileError?: string;
  outputs?: string[];
  children?: Array<{ status: string }>;
}

const TOKEN = /PHASE\d{3}-[A-Z0-9-]+/;
const FILE = /proof\/[A-Za-z0-9._-]+\.(?:txt|mjs)/;
const URL = /https?:\/\/[^\s<>)]+/i;

/** Action requests only. A greeting or a plain question has no contract. */
export function contractForPrompt(text: string): ExecutionContract | null {
  const input = text.trim();
  if (!input || input.length < 8) return null;
  const url = input.match(URL)?.[0]?.replace(/[.,!?]+$/, "");
  const token = input.match(TOKEN)?.[0];
  const file = input.match(FILE)?.[0];
  if (/çocuk görev|iki alt görev|task_spawn|subagent/i.test(input)) return { kind: "subagents", token, file };
  if (/desktop_type|nano ile|masaüstünde/i.test(input)) return { kind: "desktop-type", token, file };
  if (/console\.log|node ile çalıştır|çalıştır/i.test(input) && /kod|mjs|js|script/i.test(input)) return { kind: "code-run", token, file };
  if (/browser_fill|formu doldur|müşteri ad|formunda/i.test(input)) return { kind: "browser-form", url, token };
  if (/browser_click|bağlantıya tıkla|linke tıkla|More information/i.test(input)) {
    return { kind: "browser-click", url, expectUrlIncludes: /example\.com/i.test(input) ? "iana.org" : undefined };
  }
  if (/browser_open_read|sayfayı aç|siteyi aç/i.test(input) || (/example\.com/i.test(input) && /aç|open/i.test(input) && !/tıkla|click/i.test(input))) {
    return { kind: "browser-open", url, expectUrlIncludes: "example.com" };
  }
  return null;
}

function okTool(view: EvidenceView, name: string): boolean {
  return view.tools.some((tool) => tool.name === name && !tool.isError);
}

/** `retry` is true only when the required action has not run yet. A finished action is not repeated. */
export function missingEvidence(contract: ExecutionContract, view: EvidenceView): { missing: string; uncertain: boolean; retry: boolean } | null {
  if (contract.kind === "browser-open") {
    if (!okTool(view, "browser_open_read") && !okTool(view, "browser_navigate") && !okTool(view, "vm_browser_goto")) {
      return { missing: "The page was not opened. Call browser_open_read and stop.", uncertain: false, retry: true };
    }
    const page = `${view.pageUrl ?? ""} ${view.pageTitle ?? ""}`;
    if (contract.expectUrlIncludes && !page.toLowerCase().includes(contract.expectUrlIncludes.toLowerCase())) {
      return { missing: `The open page is ${view.pageUrl || "unknown"}. It does not show ${contract.expectUrlIncludes}.`, uncertain: false, retry: false };
    }
    return null;
  }
  if (contract.kind === "browser-click") {
    if (!okTool(view, "browser_click")) {
      return { missing: "browser_snapshot is not a click. Call browser_click with the ref from a fresh snapshot.", uncertain: false, retry: true };
    }
    if (contract.expectUrlIncludes && !(view.pageUrl ?? "").toLowerCase().includes(contract.expectUrlIncludes.toLowerCase())) {
      return { missing: `The click did not reach ${contract.expectUrlIncludes}. The page is ${view.pageUrl || "unknown"}.`, uncertain: false, retry: false };
    }
    return null;
  }
  if (contract.kind === "browser-form") {
    if (!okTool(view, "browser_fill") || !okTool(view, "browser_click")) {
      return { missing: "Fill the field with browser_fill and submit it with browser_click.", uncertain: false, retry: true };
    }
    if (contract.token && !`${view.pageText ?? ""} ${view.outputs?.join("\n") ?? ""}`.includes(contract.token)) {
      return { missing: `The result page does not contain ${contract.token}.`, uncertain: false, retry: false };
    }
    return null;
  }
  if (contract.kind === "desktop-type") {
    const typed = (okTool(view, "desktop_click") && okTool(view, "desktop_type")) || okTool(view, "desktop_batch");
    if (!typed) {
      return { missing: "desktop_state is not typing. Focus the new file, then desktop_click and desktop_type, then save.", uncertain: false, retry: true };
    }
    if (view.fileError && !/no such file|not found/i.test(view.fileError)) {
      return { missing: `The saved file could not be read: ${view.fileError}`, uncertain: true, retry: false };
    }
    if (!contract.token || !view.fileText?.includes(contract.token)) {
      return { missing: `The file ${contract.file ?? ""} does not contain the new text.`, uncertain: false, retry: false };
    }
    return null;
  }
  if (contract.kind === "code-run") {
    if (!okTool(view, "shell_exec") && !okTool(view, "code_run")) {
      return { missing: "Run the program with shell_exec or code_run.", uncertain: false, retry: true };
    }
    const output = view.outputs?.join("\n") ?? "";
    if (contract.token && !output.includes(contract.token)) {
      return { missing: `The command output does not contain ${contract.token}.`, uncertain: false, retry: false };
    }
    return null;
  }
  const spawns = view.tools.filter((tool) => tool.name === "task_spawn" && !tool.isError).length;
  if (spawns < 2) return { missing: "Start two child tasks with task_spawn.", uncertain: false, retry: true };
  const children = view.children ?? [];
  if (children.length < 2 || children.some((child) => child.status === "queued" || child.status === "running" || child.status === "waiting_children")) {
    return { missing: "Wait until both child tasks finish.", uncertain: false, retry: true };
  }
  return null;
}

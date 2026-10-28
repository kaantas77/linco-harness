export type ContractKind = "browser-open" | "browser-click" | "browser-form" | "desktop-type" | "code-run" | "subagents";

/** Derived from the user text. The model cannot replace it. Chat requests stay unset. */
export interface ExecutionContract {
  kind: ContractKind;
  url?: string;
  token?: string;
  file?: string;
  expectUrlIncludes?: string;
}

/** Fields copied from the tool result. The clipped result text is not this record. */
export interface ProgramRun {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  path?: string;
  command?: string;
}

export interface ToolUse {
  name: string;
  isError: boolean;
  args?: string;
  result?: string;
  run?: ProgramRun;
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

const TOKEN = /PHASE\d{3}-[A-Z0-9-]+|[A-Z][A-Z0-9]+-\d{2,}/;
const FILE = /(?:proof\/)?[A-Za-z0-9._-]+\.(?:txt|mjs|js|py)/;
const URL = /https?:\/\/[^\s<>)]+/i;
const DESKTOP = /masaüstünde|masaustunde|on the desktop|desktop editor|nano ile|text editor|yaz ve kaydet|type .{0,48} and save|desktop_edit_file|desktop_type/i;
const CODE = /kod(?:u|unu)? yaz|write (?:a |the )?(?:node |javascript |python )?(?:program|script)|node ile çalıştır|çalıştır|run (?:the |it|this )?(?:code|program|script)|console\.log|execute (?:the |it|this )?(?:file|script|program)/i;
const CODE_TOPIC = /kod|program|script|console\.log|\.mjs|\.js\b|\.py\b|node|python/i;

/** Action requests only. A greeting or a plain question has no contract. */
export function contractForPrompt(text: string): ExecutionContract | null {
  const input = text.trim();
  if (!input || input.length < 8) return null;
  const url = input.match(URL)?.[0]?.replace(/[.,!?]+$/, "");
  const token = input.match(TOKEN)?.[0];
  const file = input.match(FILE)?.[0];
  if (/çocuk görev|iki alt görev|iki çocuk|task_spawn|subagent|child tasks/i.test(input)) return { kind: "subagents", token, file };
  if (DESKTOP.test(input)) return { kind: "desktop-type", token, file };
  if (CODE.test(input) && CODE_TOPIC.test(input)) return { kind: "code-run", token, file };
  if (/browser_fill|formu doldur|müşteri ad|formunda|fill (?:the |a )?form/i.test(input)) return { kind: "browser-form", url, token };
  if (/browser_click|bağlantıya tıkla|linke tıkla|click (?:the |a )?link|More information/i.test(input)) {
    return { kind: "browser-click", url, expectUrlIncludes: /example\.com/i.test(input) ? "iana.org" : undefined };
  }
  if (/browser_open_read|sayfayı aç|siteyi aç|open (?:the )?(?:site|page)/i.test(input) || (/example\.com/i.test(input) && /aç|open/i.test(input) && !/tıkla|click/i.test(input))) {
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
    const typed = (okTool(view, "desktop_click") && okTool(view, "desktop_type")) || okTool(view, "desktop_batch") || okTool(view, "desktop_edit_file");
    if (!typed) {
      return {
        missing: `Call desktop_edit_file once with path ${contract.file ?? ""} and text ${contract.token ?? ""}.`,
        uncertain: false,
        retry: !okTool(view, "desktop_edit_file"),
      };
    }
    const related = !contract.file || view.tools.some((tool) => !tool.isError && tool.name === "desktop_edit_file" && `${tool.args ?? ""}`.includes(contract.file!.split("/").pop() ?? contract.file!)) || !okTool(view, "desktop_edit_file");
    if (!related) return { missing: `desktop_edit_file did not target ${contract.file}.`, uncertain: false, retry: false };
    if (view.fileError && /no such file|not found|cannot stat/i.test(view.fileError)) {
      return { missing: `The file ${contract.file ?? ""} was not saved.`, uncertain: false, retry: false };
    }
    if (view.fileError) return { missing: `The saved file could not be read: ${view.fileError}`, uncertain: true, retry: false };
    if (!contract.token || !view.fileText?.includes(contract.token)) {
      return { missing: `The file ${contract.file ?? ""} does not contain the new text.`, uncertain: false, retry: false };
    }
    return null;
  }
  if (contract.kind === "code-run") {
    const proved = view.tools.some((tool) => provedProgram(contract, tool));
    if (proved) {
      if (view.fileError && /no such file|not found|cannot stat/i.test(view.fileError)) {
        return { missing: `The program file ${contract.file ?? ""} is missing.`, uncertain: false, retry: false };
      }
      if (view.fileError) return { missing: `The program file could not be read: ${view.fileError}`, uncertain: true, retry: false };
      return null;
    }
    const attempted = view.tools.some((tool) => tool.name === "code_write_run" || tool.name === "shell_exec");
    return {
      missing: `Call code_write_run once with path ${contract.file ?? ""} and source that prints ${contract.token ?? ""}. A failed command does not count.`,
      uncertain: false,
      retry: !attempted,
    };
  }
  const spawns = view.tools.filter((tool) => tool.name === "task_spawn" && !tool.isError).length;
  if (spawns < 2) return { missing: "Start two child tasks with task_spawn.", uncertain: false, retry: true };
  const children = view.children ?? [];
  if (children.length < 2 || children.some((child) => child.status === "queued" || child.status === "running" || child.status === "waiting_children")) {
    return { missing: "Wait until both child tasks finish.", uncertain: false, retry: true };
  }
  if (children.some((child) => child.status !== "succeeded")) {
    return { missing: "A failed or cancelled child is not success.", uncertain: false, retry: false };
  }
  return null;
}

/** Read the tool's own details. A sentence that says "exit 0" is not a run record. */
export function programRunFromDetails(details: unknown): ProgramRun | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;
  if (typeof record.exitCode !== "number" || !Number.isInteger(record.exitCode)) return undefined;
  const run: ProgramRun = {
    exitCode: record.exitCode,
    timedOut: record.timedOut === true,
    stdout: typeof record.stdout === "string" ? record.stdout.slice(0, 2_000) : "",
  };
  if (typeof record.path === "string" && record.path) run.path = record.path.slice(0, 240);
  if (typeof record.command === "string" && record.command) run.command = record.command.slice(0, 500);
  return run;
}

function provedProgram(contract: ExecutionContract, tool: ToolUse): boolean {
  if (tool.isError || (tool.name !== "code_write_run" && tool.name !== "shell_exec")) return false;
  const run = tool.run;
  if (!run || run.timedOut || run.exitCode !== 0) return false;
  const base = contract.file?.split("/").pop() ?? "";
  if (!base) return false;
  const targeted = (run.path !== undefined && fileBase(run.path) === base) || (run.command !== undefined && commandNamesFile(run.command, base));
  if (!targeted) return false;
  if (contract.token && !run.stdout.includes(contract.token)) return false;
  return true;
}

function commandNamesFile(command: string, base: string): boolean {
  return command.split(/[\s"'`]+/).some((token) => token.length > 0 && fileBase(token) === base);
}

function fileBase(value: string): string {
  const cleaned = value.replaceAll("\\", "/").replace(/[),;]+$/g, "");
  return cleaned.split("/").pop() ?? "";
}

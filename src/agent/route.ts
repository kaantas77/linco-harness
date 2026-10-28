import { directOpenIntent } from "../boat/ax-snapshot.js";

/** Which tool list a task may see. `agent` keeps the full session list. */
export type ToolProfile = "agent" | "search" | "browser" | "desktop" | "code";

export interface ExecutionRoute {
  profile: ToolProfile;
  reason: string;
}

const NO_BROWSER = /tarayıcı(?:yı|sini)?\s+kullanma|do not use (?:a )?browser|yalnızca\s+api|only\s+api/iu;
const RESEARCH = /araştır|research|web(?:den|\s+search)?|internet(?:te)?|karşılaştır|özetle|haber/iu;
const DESKTOP = /masaüstü|masaustu|desktop|text editor|nano|gedit|pencere/iu;
const CODE = /kod(?:unu|u)?\s+(?:yaz|çalıştır)|write\s+(?:a\s+|the\s+)?(?:node\s+|javascript\s+|python\s+)?(?:program|script)|run\s+(?:the\s+|it\s+|this\s+)?(?:code|script|program)|execute\s+(?:the\s+)?script|shell|terminalde\s+çalıştır/iu;
const BROWSER = /form|site(?:yi|yı)|sayfa(?:yı|yi)|chrome|tarayıcı/iu;
const BROWSER_ACTION = /a[cç]|open|doldur|fill|tıkla|click|git|navigate/iu;

/**
 * Deterministic first pass, adapted from OpenMausBot `routeExecution`.
 * Ambiguous text stays on `agent` so the planner keeps every tool.
 */
export function routeExecution(text: string): ExecutionRoute {
  const input = text.trim();
  if (!input || /^\s*\[ilk tur\]/i.test(input)) return { profile: "agent", reason: "chat" };
  if (NO_BROWSER.test(input)) return { profile: "search", reason: "browser disabled" };
  if (CODE.test(input) && !BROWSER.test(input)) return { profile: "code", reason: "code" };
  if (DESKTOP.test(input) && !/https?:\/\//iu.test(input)) return { profile: "desktop", reason: "desktop" };
  if (directOpenIntent(input) || (BROWSER.test(input) && BROWSER_ACTION.test(input))) return { profile: "browser", reason: "browser" };
  if (RESEARCH.test(input)) return { profile: "search", reason: "research" };
  return { profile: "agent", reason: "agent" };
}

const ALLOWED: Record<Exclude<ToolProfile, "agent">, ReadonlySet<string>> = {
  search: new Set(["web_fetch", "web_search", "web_extract", "memory_search", "memory_save"]),
  browser: new Set([
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_fill",
    "browser_select",
    "browser_open_read",
    "vm_browser_goto",
    "vm_browser_read",
    "vm_browser_fill",
  ]),
  desktop: new Set(["desktop_edit_file"]),
  code: new Set(["fs_list", "fs_read", "fs_write", "fs_edit", "shell_exec", "code_run", "code_write_run"]),
};

/** `agent` returns the list unchanged. Other profiles hide tools that are outside the route. */
export function toolsForRoute<T extends { name: string }>(tools: T[], profile: ToolProfile | undefined): T[] {
  if (!profile || profile === "agent") return tools;
  const allowed = ALLOWED[profile];
  return tools.filter((tool) => allowed.has(tool.name));
}

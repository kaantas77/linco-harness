import type { AgentTool } from "@earendil-works/pi-agent-core";
import { buildStablePrompt } from "../prompt/layout.js";
import type { SkillSummary } from "../skills/catalog.js";
import { browserTools } from "./browser-tools.js";
import { createTools } from "./create-tools.js";
import type { ToolHost } from "./host.js";

export const BROWSER_TOOLSET_MARK = "linco-toolset: v2-browser";

const BROWSER_SUFFIX = [
  BROWSER_TOOLSET_MARK,
  "Tarayıcı araçları bu oturumda açıktır. web_fetch değişmedi.",
  "Sayfayı browser_snapshot ile oku. Ref değeri yalnızca o snapshotId için geçerlidir.",
  "browser_click ve browser_fill, ref ile birlikte snapshotId ister.",
  "İşin bittiğini browser_verify ile taze sayfadan doğrula.",
  "Profil dizini çalışma alanındaki .linco/browser içindedir. Aynı profil aynı anda iki görevde açılmaz.",
].join("\n");

/** v1 prompt plus a stable suffix. Existing sessions keep the stored v1 prompt. */
export function withBrowserToolset(prompt: string): string {
  if (prompt.includes(BROWSER_TOOLSET_MARK)) return prompt;
  return `${prompt}\n\n${BROWSER_SUFFIX}`;
}

export function browserPrompt(skills: SkillSummary[]): string {
  return withBrowserToolset(buildStablePrompt(skills));
}

export function sessionHasBrowser(prompt: string): boolean {
  return prompt.includes(BROWSER_TOOLSET_MARK);
}

/** v1 sessions keep createTools. v2 sessions append the browser tools in a fixed order. */
export function toolsForPrompt(host: ToolHost, prompt: string): AgentTool[] {
  const base = createTools(host);
  if (!sessionHasBrowser(prompt)) return base;
  return [...base, ...browserTools(host)];
}

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { buildStablePrompt } from "../prompt/layout.js";
import type { SkillSummary } from "../skills/catalog.js";
import { browserTools, jevTools } from "./browser-tools.js";
import { createTools } from "./create-tools.js";
import type { ToolHost } from "./host.js";

export const BROWSER_TOOLSET_MARK = "linco-toolset: v2-browser";
export const JEV_TOOLSET_MARK = "linco-toolset: v3-jev";

const BROWSER_SUFFIX = [
  BROWSER_TOOLSET_MARK,
  "Tarayıcı araçları bu oturumda açıktır. web_fetch değişmedi.",
  "Sayfayı browser_snapshot ile oku. Ref değeri yalnızca o snapshotId için geçerlidir.",
  "browser_click ve browser_fill, ref ile birlikte snapshotId ister.",
  "İşin bittiğini browser_verify ile taze sayfadan doğrula.",
  "Profil dizini çalışma alanındaki .linco/browser içindedir. Aynı profil aynı anda iki görevde açılmaz.",
].join("\n");

const JEV_SUFFIX = [
  JEV_TOOLSET_MARK,
  "Sınırlı tarayıcı alt hedefi jev_run ile yürür. Jev, TypeSafe jev-latest modelinden CLICK, FILL veya SELECT seçer.",
  "Sonuç taze semantic snapshot ile doğrulanır. expected içinde url, title veya tek bir öğe verilir.",
  "inputs, alanın role ve name değerine bağlıdır. Şifre ve ödeme yazılmaz.",
  "TYPESAFE_API_KEY yoksa jev_run çalışmaz ve başarı bildirmez.",
  "Escalate sonrası browser_click, browser_fill ve browser_select ile onarılır. Aynı hedef, sayfa değişmeden yeniden denenmez.",
].join("\n");

/** v1 prompt plus a stable suffix. Existing sessions keep the stored v1 prompt. */
export function withBrowserToolset(prompt: string): string {
  if (prompt.includes(BROWSER_TOOLSET_MARK) || prompt.includes(JEV_TOOLSET_MARK)) return prompt;
  return `${prompt}\n\n${BROWSER_SUFFIX}`;
}

/** New sessions. v2-browser stays inside the prompt so an older mark check still sees the browser generation. */
export function withJevToolset(prompt: string): string {
  if (prompt.includes(JEV_TOOLSET_MARK)) return prompt;
  const browser = withBrowserToolset(prompt);
  return `${browser}\n\n${JEV_SUFFIX}`;
}

export function browserPrompt(skills: SkillSummary[]): string {
  return withJevToolset(buildStablePrompt(skills));
}

export function sessionHasBrowser(prompt: string): boolean {
  return prompt.includes(BROWSER_TOOLSET_MARK) || prompt.includes(JEV_TOOLSET_MARK);
}

export function sessionHasJev(prompt: string): boolean {
  return prompt.includes(JEV_TOOLSET_MARK);
}

/** v1 sessions keep createTools. v2 appends browser tools. v3 appends browser_select and jev_run. */
export function toolsForPrompt(host: ToolHost, prompt: string): AgentTool[] {
  const base = createTools(host);
  if (!sessionHasBrowser(prompt)) return base;
  const browser = browserTools(host);
  if (!sessionHasJev(prompt)) return [...base, ...browser];
  return [...base, ...browser, ...jevTools(host)];
}

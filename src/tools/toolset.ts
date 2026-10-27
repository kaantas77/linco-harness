import type { AgentTool } from "@earendil-works/pi-agent-core";
import { buildStablePrompt } from "../prompt/layout.js";
import type { SkillSummary } from "../skills/catalog.js";
import { browserTools, jevTools } from "./browser-tools.js";
import { createTools } from "./create-tools.js";
import { desktopTools } from "./desktop-tools.js";
import { vmBrowserTools } from "./vm-browser-tools.js";
import { goalTools } from "./goal-tools.js";
import type { ToolHost } from "./host.js";

export const BROWSER_TOOLSET_MARK = "linco-toolset: v2-browser";
export const JEV_TOOLSET_MARK = "linco-toolset: v3-jev";
export const PLAN_TOOLSET_MARK = "linco-toolset: v4-plan";

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

const PLAN_SUFFIX = [
  PLAN_TOOLSET_MARK,
  "Karmaşık işlerde goal_set ile hedef, bağımlılık, beklenen çıktı ve ölçülebilir kriter yaz. Tek adımlık işte plan açma.",
  "goal_status yalnızca aktif adımların, eksik bağımlılıkların ve kriter durumunun kısa özetini verir.",
  "Hazır adımları goal_dispatch ile kuyruğa bırak. Bağımlılığı bitmemiş adım başlamaz.",
  "goal_evidence kriteri kendisi kontrol eder. Dosya, araç izi veya çocuk sonucu yoksa adım tamamlanmış sayılmaz.",
  "Başarısız adımda goal_replan bitmiş adımları tutar ve yalnızca kalan işi ekler. Aynı hata ikinci kez planlanmaz.",
].join("\n");

/** v3 prompt plus the goal tools. Older sessions keep their stored prompt and the checklist plan_write. */
export function withPlanToolset(prompt: string): string {
  if (prompt.includes(PLAN_TOOLSET_MARK)) return prompt;
  return `${withJevToolset(prompt)}\n\n${PLAN_SUFFIX}`;
}

export function browserPrompt(skills: SkillSummary[]): string {
  return withPlanToolset(buildStablePrompt(skills));
}

export const BOAT_TOOLSET_MARK = "linco-computer: boat";

const BOAT_SUFFIX = [
  BOAT_TOOLSET_MARK,
  "Dosya, kabuk ve masaüstü bu kullanıcının Boat bilgisayarındadır. Çalışma yolu /home/user/linco.",
  "Host dosya sistemi bu araçların hedefi değildir.",
  "browser_* ve jev_run bu oturumda yoktur. Masaüstü için desktop_state, desktop_tree ve desktop_screenshot kullan.",
  "desktop_click, desktop_type, desktop_window ve desktop_browser onay ister.",
  "vm_browser_goto ve vm_browser_fill bu sanal makinedeki izole Chrome profilini kullanır ve onay ister. Host tarayıcısı açılmaz.",
  "Model görüntü kabul etmiyorsa ekran görüntüsü yerine erişilebilirlik ağacı döner.",
].join("\n");

/** New Boat sessions only. Local sessions keep the stored prompt bytes. */
export function withBoatComputer(prompt: string): string {
  if (prompt.includes(BOAT_TOOLSET_MARK)) return prompt;
  return `${prompt}\n\n${BOAT_SUFFIX}`;
}

export function sessionHasBrowser(prompt: string): boolean {
  return prompt.includes(BROWSER_TOOLSET_MARK) || prompt.includes(JEV_TOOLSET_MARK);
}

export function sessionHasJev(prompt: string): boolean {
  return prompt.includes(JEV_TOOLSET_MARK);
}

export function sessionHasPlan(prompt: string): boolean {
  return prompt.includes(PLAN_TOOLSET_MARK);
}

/** v1 sessions keep createTools. v2 appends browser tools. v3 appends browser_select and jev_run. v4 appends goal tools.
 * A Boat binding replaces the host browser with the sandbox desktop.
 * vm_browser_* runs Chrome inside that VM. It does not add the host Playwright tools. */
export function toolsForPrompt(host: ToolHost, prompt: string): AgentTool[] {
  const base = createTools(host);
  if (host.desktop) {
    const desktop = [...base, ...desktopTools(host), ...vmBrowserTools(host)];
    return sessionHasPlan(prompt) ? [...desktop, ...goalTools(host)] : desktop;
  }
  if (!sessionHasBrowser(prompt)) return base;
  const browser = browserTools(host);
  const withBrowser = sessionHasJev(prompt) ? [...base, ...browser, ...jevTools(host)] : [...base, ...browser];
  if (!sessionHasPlan(prompt)) return withBrowser;
  return [...withBrowser, ...goalTools(host)];
}

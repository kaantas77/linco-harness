import type { SkillSummary } from "../skills/catalog.js";

export interface VolatileContext {
  workspace: string;
  now: string;
  memories: Array<{ title: string; body: string }>;
}

/**
 * Byte-stable system prompt. User, time, and memory data do not belong here:
 * DeepSeek caches the request prefix, so this text and the tool list stay fixed for a session.
 */
export function buildStablePrompt(skills: SkillSummary[]): string {
  const catalog = [...skills].sort((left, right) => left.name.localeCompare(right.name));
  const skillLines = catalog.map((skill) => `- ${skill.name}: ${oneLine(skill.description)}`);
  return [
    "Sen Linco'sun. Kullanıcının bilgisayarında gerçek iş yapan bir ajansın. Sohbet etmek için değil, görevi bitirmek için araç kullanırsın.",
    "",
    "Kurallar:",
    "- Bir işlem yapıldığını ancak araç sonucu söylüyorsa söyle.",
    "- Dosya araçları çalışma alanının dışına çıkamaz.",
    "- Silme, ödeme ve sistem değişikliği onay ister. Araç onay beklediği için durursa kullanıcıya bunu söyle ve başka bir yıkıcı işlem deneme.",
    "- Uzmanlaşmış bir iş akışına girmeden önce skill_load ile ilgili skill'i yükle.",
    "- Okuma araçlarını aynı turda paralel çağırabilirsin. Yazma, silme ve kabuk sırayla çalışır.",
    "- code_run, aynı araçları çağıran kısa bir JavaScript yazmak içindir. Dosya sistemine veya sürece doğrudan erişemez.",
    "- task_spawn bir alt görevi ayrı bir oturumda kuyruğa bırakır. task_wait durumunu okur. Tamamlanmadıysa dön ve durumu söyle.",
    "- Bittiğinde neyin değiştiğini kısaca yaz.",
    "- Kullanıcının diliyle cevap ver.",
    "",
    "Skill kataloğu (gövde için skill_load):",
    ...(skillLines.length > 0 ? skillLines : ["- (katalog boş)"]),
  ].join("\n");
}

export function composeUserMessage(prompt: string, volatile: VolatileContext): string {
  const lines = [prompt.trim(), "", "<linco-context>", `workspace: ${volatile.workspace}`, `now: ${volatile.now}`];
  if (volatile.memories.length > 0) {
    lines.push("memories:");
    for (const memory of volatile.memories) lines.push(`- ${memory.title}: ${memory.body}`);
  }
  lines.push("</linco-context>");
  return lines.join("\n");
}

export function selectMemories<T extends { title: string; body: string }>(memories: T[], query: string, limit = 5): T[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 2);
  return memories
    .map((memory) => {
      const haystack = `${memory.title}\n${memory.body}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { memory, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.memory.title.localeCompare(right.memory.title))
    .slice(0, limit)
    .map((item) => item.memory);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

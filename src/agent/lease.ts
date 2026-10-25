/** Reads can run again. Mutations and external calls cannot. */
const SAFE_TOOLS = new Set([
  "fs_list",
  "fs_read",
  "skill_list",
  "skill_load",
  "memory_search",
  "goal_status",
  "goal_evidence",
  "task_wait",
]);

export type RecoveryDecision = "requeue" | "inspect";

export interface EffectTrace {
  kind: string;
  name: string;
  data: unknown;
}

export function effectOf(toolName: string): "safe" | "uncertain" {
  return SAFE_TOOLS.has(toolName) ? "safe" : "uncertain";
}

/**
 * A task with no durable side effect can be queued again.
 * An uncertain tool, or a tool that started and did not finish, needs a person.
 */
export function recoveryDecision(traces: EffectTrace[]): RecoveryDecision {
  const starts = new Set<string>();
  const ends = new Set<string>();
  let uncertain = false;
  for (const trace of traces) {
    if (trace.kind !== "tool") continue;
    const data = trace.data && typeof trace.data === "object" ? (trace.data as { phase?: unknown; toolCallId?: unknown }) : {};
    const id = typeof data.toolCallId === "string" ? data.toolCallId : "";
    if (data.phase === "start") {
      if (id) starts.add(id);
      continue;
    }
    if (id) ends.add(id);
    if (effectOf(trace.name) === "uncertain") uncertain = true;
  }
  for (const id of starts) {
    if (!ends.has(id)) return "inspect";
  }
  return uncertain ? "inspect" : "requeue";
}

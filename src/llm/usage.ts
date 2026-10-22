import type { Usage } from "@earendil-works/pi-ai";
import type { UsageSummary } from "../types.js";

export function emptyUsage(): UsageSummary {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    cacheHitRatio: 0,
  };
}

export function addModelUsage(summary: UsageSummary, usage: Usage): UsageSummary {
  const next: UsageSummary = {
    turns: summary.turns + 1,
    inputTokens: summary.inputTokens + usage.input,
    outputTokens: summary.outputTokens + usage.output,
    cacheReadTokens: summary.cacheReadTokens + usage.cacheRead,
    cacheWriteTokens: summary.cacheWriteTokens + usage.cacheWrite,
    costUsd: summary.costUsd + usage.cost.total,
    cacheHitRatio: 0,
  };
  next.cacheHitRatio = cacheHitRatio(next);
  return next;
}

/** DeepSeek reports cache hits separately. Pi maps `prompt_cache_hit_tokens` onto `cacheRead`. */
export function cacheHitRatio(summary: Pick<UsageSummary, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number {
  const denominator = summary.inputTokens + summary.cacheReadTokens + summary.cacheWriteTokens;
  if (denominator <= 0) return 0;
  return summary.cacheReadTokens / denominator;
}

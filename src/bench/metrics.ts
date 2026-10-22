export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface CacheComparison {
  firstCallCacheRead: number | null;
  secondCallCacheRead: number | null;
  /** True when the second model call reported a DeepSeek cache hit. Null when a second call did not happen. */
  secondCallHit: boolean | null;
}

/** Pi stores uncached prompt tokens on `input` and DeepSeek cache hits on `cacheRead`. */
export function cacheMissTokens(call: CallUsage): number {
  return call.inputTokens;
}

export function sumCalls(calls: CallUsage[]): CallUsage {
  return calls.reduce(
    (total, call) => ({
      inputTokens: total.inputTokens + call.inputTokens,
      outputTokens: total.outputTokens + call.outputTokens,
      cacheReadTokens: total.cacheReadTokens + call.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + call.cacheWriteTokens,
      costUsd: total.costUsd + call.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  );
}

export function cacheHitRatio(call: Pick<CallUsage, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number {
  const denominator = call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens;
  if (denominator <= 0) return 0;
  return call.cacheReadTokens / denominator;
}

/** Compare the first two model calls. This does not decide which runner is better. */
export function compareCache(calls: CallUsage[]): CacheComparison {
  const first = calls[0];
  const second = calls[1];
  return {
    firstCallCacheRead: first?.cacheReadTokens ?? null,
    secondCallCacheRead: second?.cacheReadTokens ?? null,
    secondCallHit: second ? second.cacheReadTokens > 0 : null,
  };
}

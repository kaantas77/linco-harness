import type { CacheComparison, CallUsage } from "./metrics.js";

export type BenchRunner = "linco" | "pi";

export interface ScenarioResult {
  runner: BenchRunner;
  scenarioId: string;
  group: string;
  ok: boolean;
  status: string;
  durationMs: number;
  firstResponseMs: number | null;
  usage: CallUsage;
  cacheHitRatio: number;
  calls: CallUsage[];
  cache: CacheComparison & {
    systemPromptStable: boolean | null;
    toolOrderStable: boolean | null;
    /** Null when the model returned no thinking blocks, so preservation could not be observed. */
    reasoningPreserved: boolean | null;
  };
  detail: string;
}

export interface BenchReport {
  createdAt: string;
  mode: "offline" | "live";
  model: string;
  liveExecuted: boolean;
  /** Always none. One run is a measurement, not a ranking. */
  performanceClaim: "none";
  results: ScenarioResult[];
  notes: string[];
}

export function redactSecrets(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]");
}

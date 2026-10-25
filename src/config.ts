import path from "node:path";

export interface LincoConfig {
  dataDir: string;
  skillsDir: string;
  host: string;
  port: number;
  workerCount: number;
  maxTurns: number;
  model: string;
  apiKey?: string;
  /** Omitted means the agent default, which is off. */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  compactMaxChars: number;
  /** When false, the model receives the stored transcript unchanged. */
  compactRequests: boolean;
  schedulerIntervalMs: number;
  /** How long a claimed task stays running without a heartbeat. */
  leaseMs: number;
  heartbeatMs: number;
}

export function loadConfig(
  overrides: Partial<LincoConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): LincoConfig {
  const dataDir = overrides.dataDir ?? env.LINCO_DATA_DIR ?? path.resolve(".data");
  return {
    dataDir,
    skillsDir: overrides.skillsDir ?? env.LINCO_SKILLS_DIR ?? path.resolve("skills"),
    host: overrides.host ?? env.LINCO_HOST ?? "127.0.0.1",
    port: overrides.port ?? numberEnv(env.LINCO_PORT, 8787),
    workerCount: overrides.workerCount ?? numberEnv(env.LINCO_WORKERS, 2),
    maxTurns: overrides.maxTurns ?? numberEnv(env.LINCO_MAX_TURNS, 24),
    model: overrides.model ?? env.LINCO_MODEL ?? "deepseek-flash",
    apiKey: overrides.apiKey ?? env.DEEPSEEK_API_KEY,
    compactMaxChars: overrides.compactMaxChars ?? numberEnv(env.LINCO_COMPACT_CHARS, 180_000),
    compactRequests: overrides.compactRequests ?? env.LINCO_COMPACT !== "0",
    schedulerIntervalMs: overrides.schedulerIntervalMs ?? numberEnv(env.LINCO_SCHEDULER_MS, 1_000),
    leaseMs: overrides.leaseMs ?? numberEnv(env.LINCO_LEASE_MS, 15_000),
    heartbeatMs: overrides.heartbeatMs ?? numberEnv(env.LINCO_HEARTBEAT_MS, 2_000),
  };
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

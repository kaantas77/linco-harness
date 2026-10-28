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
  /** `token` rejects anonymous API calls. `dev` is the open loopback mode. */
  authMode: "token" | "dev";
  /** Stable bootstrap secret. When omitted, the API process generates one. */
  bootstrapToken?: string;
  /** Worker processes leave credential rows to the API process. */
  manageCredentials: boolean;
  /** Lets web_fetch and the browser open loopback. Off unless set. */
  allowLoopback: boolean;
  /** `require` refuses shell and code mode when the OS sandbox is missing. */
  sandbox: "require" | "off";
  /** `local` keeps the host workspace. `boat` binds each user to one remote computer. */
  computer: "local" | "boat";
  boatApiKey?: string;
  boatBaseUrl?: string;
  boatMachineType: "small" | "default" | "large" | "xlarge";
  boatTtlSeconds: number;
  boatIdleStopMs: number;
  boatMaxSeconds: number;
  /** One task stops when tokens or USD pass these ceilings. */
  taskMaxTokens: number;
  taskMaxCostUsd: number;
  /** Boat Chrome stays off until the private-pilot network gates close. */
  vmBrowser: boolean;
}

export function loopbackHost(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

export function loadConfig(
  overrides: Partial<LincoConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): LincoConfig {
  const computer = overrides.computer ?? (env.LINCO_COMPUTER === "boat" ? "boat" : "local");
  return {
    dataDir: overrides.dataDir ?? env.LINCO_DATA_DIR ?? path.resolve(".data"),
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
    authMode: overrides.authMode ?? (env.LINCO_AUTH === "dev" ? "dev" : "token"),
    bootstrapToken: present(overrides.bootstrapToken ?? env.LINCO_BOOTSTRAP_TOKEN),
    manageCredentials: overrides.manageCredentials ?? true,
    allowLoopback: overrides.allowLoopback ?? env.LINCO_ALLOW_LOOPBACK === "1",
    sandbox: overrides.sandbox ?? (env.LINCO_SANDBOX === "off" ? "off" : "require"),
    computer,
    boatApiKey: computer === "boat" ? present(overrides.boatApiKey ?? env.BOAT_API_KEY) : undefined,
    boatBaseUrl: present(overrides.boatBaseUrl ?? env.BOAT_API_BASE),
    boatMachineType: machineType(overrides.boatMachineType ?? env.LINCO_BOAT_TYPE),
    boatTtlSeconds: overrides.boatTtlSeconds ?? numberEnv(env.LINCO_BOAT_TTL_SECONDS, 3_600),
    boatIdleStopMs: overrides.boatIdleStopMs ?? numberEnv(env.LINCO_BOAT_IDLE_MS, 15 * 60_000),
    boatMaxSeconds: overrides.boatMaxSeconds ?? numberEnv(env.LINCO_BOAT_MAX_SECONDS, 7_200),
    taskMaxTokens: overrides.taskMaxTokens ?? numberEnv(env.LINCO_TASK_MAX_TOKENS, 500_000),
    taskMaxCostUsd: overrides.taskMaxCostUsd ?? numberEnv(env.LINCO_TASK_MAX_COST_USD, 2),
    vmBrowser: overrides.vmBrowser ?? env.LINCO_VM_BROWSER === "1",
  };
}

function present(value: string | undefined): string | undefined {
  if (!value || !value.trim()) return undefined;
  return value;
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function machineType(value: string | undefined): "small" | "default" | "large" | "xlarge" {
  if (value === "default" || value === "large" || value === "xlarge" || value === "small") return value;
  return "small";
}

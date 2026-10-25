export type TaskKind = "chat" | "cron" | "webhook" | "heartbeat" | "bench" | "child";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_children"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "needs_inspection";

export type MemoryKind = "preference" | "fact" | "project" | "task";

export type AutomationKind = "cron" | "heartbeat" | "webhook";

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface User {
  id: string;
  name: string;
  workspacePath: string;
  createdAt: string;
}

export interface Session {
  id: string;
  userId: string;
  workspacePath: string;
  systemPrompt: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "doing" | "done";
}

export type GoalCriterionStatus = "pending" | "verified" | "unverified" | "blocked";

export type GoalCheck =
  | { kind: "file_exists"; path: string }
  | { kind: "file_contains"; path: string; text: string }
  | { kind: "tool_ok"; tool: string }
  | { kind: "child_succeeded"; text?: string };

export interface GoalCriterion {
  id: string;
  description: string;
  required: boolean;
  check: GoalCheck;
  status: GoalCriterionStatus;
  evidence?: string;
  /** Trace row that satisfied a tool_ok check. */
  evidenceTraceId?: string;
}

export type GoalStepStatus = "pending" | "ready" | "doing" | "done" | "failed" | "replaced" | "blocked";

export interface GoalStep {
  id: string;
  title: string;
  dependsOn: string[];
  expectedOutput: string;
  status: GoalStepStatus;
  childTaskId?: string;
  criteria: GoalCriterion[];
  failure?: string;
}

export interface GoalPlan {
  version: 1;
  goal: string;
  steps: GoalStep[];
  replanBudget: number;
  replans: number;
  replanNotes: string[];
  lastFailureKey?: string;
}

export interface TaskCheckpoint {
  continuation?: string;
  /** Child task ids the parent is parked on. */
  waitFor?: string[];
  /** Resume the saved transcript instead of sending the user message again. */
  resumeChildren?: boolean;
}

/** The worker generation that is allowed to write a running task. */
export interface TaskClaim {
  taskId: string;
  fence: number;
  workerId: string;
}

export interface Task {
  id: string;
  sessionId: string;
  userId: string;
  parentId: string | null;
  kind: TaskKind;
  status: TaskStatus;
  prompt: string;
  attempt: number;
  maxAttempts: number;
  checkpoint: TaskCheckpoint | null;
  plan: PlanStep[] | null;
  goal: GoalPlan | null;
  resultText: string | null;
  error: string | null;
  workerId: string | null;
  /** Monotonic generation. A stale worker holds an older value. */
  fence: number;
  leaseUntil: string | null;
  heartbeatAt: string | null;
  firstResponseMs: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Approval {
  id: string;
  taskId: string;
  toolName: string;
  args: unknown;
  argsHash: string;
  risk: string;
  status: ApprovalStatus;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Memory {
  id: string;
  userId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Automation {
  id: string;
  userId: string;
  sessionId: string;
  kind: AutomationKind;
  name: string;
  schedule: string | null;
  webhookToken: string | null;
  prompt: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  taskId: string | null;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface TraceEvent {
  id: string;
  taskId: string;
  kind: string;
  name: string;
  startedAt: string;
  endedAt: string | null;
  data: unknown;
}

export interface UsageEvent {
  id: string;
  taskId: string;
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  createdAt: string;
}

export interface UsageSummary {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  cacheHitRatio: number;
}

export type ComputerStatus = "creating" | "ready" | "stopped" | "error";

/** One Boat sandbox bound to one Linco user. The API key is not stored here. */
export interface ComputerBinding {
  userId: string;
  sandboxId: string | null;
  status: ComputerStatus;
  idempotencyKey: string;
  machineType: string;
  workspacePath: string;
  snapshotId: string | null;
  snapshotStatus: string | null;
  retentionNote: string;
  lastError: string | null;
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
}

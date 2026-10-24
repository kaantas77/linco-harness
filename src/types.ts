export type TaskKind = "chat" | "cron" | "webhook" | "heartbeat" | "bench" | "child";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_children"
  | "succeeded"
  | "failed"
  | "cancelled";

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

export interface TaskCheckpoint {
  continuation?: string;
  /** Child task ids the parent is parked on. */
  waitFor?: string[];
  /** Resume the saved transcript instead of sending the user message again. */
  resumeChildren?: boolean;
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
  resultText: string | null;
  error: string | null;
  workerId: string | null;
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

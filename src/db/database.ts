import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createId, nowIso } from "../ids.js";
import { buildStablePrompt } from "../prompt/layout.js";
import { SkillCatalog } from "../skills/catalog.js";
import type {
  Approval,
  ApprovalStatus,
  Automation,
  AutomationKind,
  Memory,
  MemoryKind,
  Notification,
  GoalPlan,
  PlanStep,
  Session,
  Task,
  TaskCheckpoint,
  TaskClaim,
  TaskKind,
  TaskStatus,
  ComputerBinding,
  TraceEvent,
  UsageEvent,
  UsageSummary,
  User,
} from "../types.js";
import { cacheHitRatio } from "../llm/usage.js";

type Sql = string | number | null;

const OPEN_TASK = new Set<TaskStatus>(["queued", "running", "waiting_children", "waiting_approval"]);
const LIVE_LEASE =
  "fence = ? AND worker_id = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until >= ?";

export class LincoDb {
  private readonly db: DatabaseSync;
  lockWaits = 0;
  private renewNs = 0;
  private renews = 0;

  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  leaseStats(): { renews: number; renewNs: number; lockWaits: number } {
    return { renews: this.renews, renewNs: this.renewNs, lockWaits: this.lockWaits };
  }

  createUser(name: string, dataDir: string): User {
    const workspacePath = path.join(dataDir, "workspaces", createId("user"));
    const user: User = { id: path.basename(workspacePath), name, workspacePath, createdAt: nowIso() };
    fs.mkdirSync(path.join(workspacePath, ".tmp"), { recursive: true });
    this.run(
      "INSERT INTO users (id, name, workspace_path, created_at) VALUES (?, ?, ?, ?)",
      user.id,
      user.name,
      user.workspacePath,
      user.createdAt,
    );
    return user;
  }

  replaceBootstrap(tokenHash: string): void {
    this.transaction(() => {
      this.run("DELETE FROM credentials WHERE kind = 'bootstrap'");
      this.run(
        "INSERT INTO credentials (token_hash, kind, user_id, created_at) VALUES (?, 'bootstrap', NULL, ?)",
        tokenHash,
        nowIso(),
      );
    });
  }

  issueUserToken(userId: string, tokenHash: string): void {
    this.run(
      "INSERT INTO credentials (token_hash, kind, user_id, created_at) VALUES (?, 'user', ?, ?)",
      tokenHash,
      userId,
      nowIso(),
    );
  }

  principalForToken(tokenHash: string): { kind: "bootstrap" } | { kind: "user"; userId: string } | undefined {
    const row = this.one<{ kind: string; user_id: string | null }>(
      "SELECT kind, user_id FROM credentials WHERE token_hash = ?",
      tokenHash,
    );
    if (!row) return undefined;
    if (row.kind === "bootstrap") return { kind: "bootstrap" };
    if (row.kind === "user" && row.user_id) return { kind: "user", userId: row.user_id };
    return undefined;
  }

  getUser(id: string): User | undefined {
    const row = this.one<UserRow>("SELECT * FROM users WHERE id = ?", id);
    return row ? mapUser(row) : undefined;
  }

  getComputer(userId: string): ComputerBinding | undefined {
    const row = this.one<ComputerRow>("SELECT * FROM computers WHERE user_id = ?", userId);
    return row ? mapComputer(row) : undefined;
  }

  /** Insert the user's single sandbox row, or return the row another caller already inserted. */
  beginComputer(
    userId: string,
    machineType: string,
    workspacePath: string,
    retentionNote: string,
  ): { record: ComputerBinding; owner: boolean } {
    const now = nowIso();
    try {
      this.run(
        `INSERT INTO computers (
          user_id, sandbox_id, status, idempotency_key, machine_type, workspace_path,
          snapshot_id, snapshot_status, retention_note, last_error, last_used_at, created_at, updated_at
        ) VALUES (?, NULL, 'creating', ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?)`,
        userId,
        createId("idem"),
        machineType,
        workspacePath,
        retentionNote,
        now,
        now,
        now,
      );
      const created = this.getComputer(userId);
      if (!created) throw new Error("computer row was not stored");
      return { record: created, owner: true };
    } catch (caught) {
      if (!isConstraint(caught)) throw caught;
      const row = this.getComputer(userId);
      if (!row) throw caught;
      if (row.sandboxId || row.status !== "creating") return { record: row, owner: false };
      if (!this.claimStaleComputer(row)) return { record: row, owner: false };
      const claimed = this.getComputer(userId);
      if (!claimed) throw caught;
      return { record: claimed, owner: true };
    }
  }

  saveComputer(
    userId: string,
    patch: {
      sandboxId?: string | null;
      status?: ComputerBinding["status"];
      snapshotId?: string | null;
      snapshotStatus?: string | null;
      lastError?: string | null;
      touch?: boolean;
    },
  ): ComputerBinding {
    const current = this.getComputer(userId);
    if (!current) throw new Error(`unknown computer for ${userId}`);
    const now = nowIso();
    this.run(
      `UPDATE computers SET sandbox_id = ?, status = ?, snapshot_id = ?, snapshot_status = ?, last_error = ?, last_used_at = ?, updated_at = ? WHERE user_id = ?`,
      patch.sandboxId === undefined ? current.sandboxId : patch.sandboxId,
      patch.status ?? current.status,
      patch.snapshotId === undefined ? current.snapshotId : patch.snapshotId,
      patch.snapshotStatus === undefined ? current.snapshotStatus : patch.snapshotStatus,
      patch.lastError === undefined ? current.lastError : patch.lastError,
      patch.touch === false ? current.lastUsedAt : now,
      now,
      userId,
    );
    const saved = this.getComputer(userId);
    if (!saved) throw new Error(`unknown computer for ${userId}`);
    return saved;
  }

  userHasOpenTask(userId: string): boolean {
    const row = this.one<{ id: string }>(
      "SELECT id FROM tasks WHERE user_id = ? AND status IN ('queued', 'running', 'waiting_children', 'waiting_approval') LIMIT 1",
      userId,
    );
    return Boolean(row);
  }

  listIdleComputers(usedBefore: string): ComputerBinding[] {
    return this.many<ComputerRow>(
      "SELECT * FROM computers WHERE status = 'ready' AND sandbox_id IS NOT NULL AND last_used_at < ?",
      usedBefore,
    ).map(mapComputer);
  }

  tryDesktopLock(sandboxId: string, taskId: string, ttlMs: number): boolean {
    const now = Date.now();
    const expires = new Date(now + ttlMs).toISOString();
    return this.transaction(() => {
      this.run("DELETE FROM desktop_locks WHERE expires_at <= ?", new Date(now).toISOString());
      const held = this.one<{ task_id: string }>("SELECT task_id FROM desktop_locks WHERE sandbox_id = ?", sandboxId);
      if (held?.task_id === taskId) {
        this.run("UPDATE desktop_locks SET expires_at = ? WHERE sandbox_id = ?", expires, sandboxId);
        return true;
      }
      if (held) return false;
      this.run(
        "INSERT INTO desktop_locks (sandbox_id, task_id, expires_at) VALUES (?, ?, ?)",
        sandboxId,
        taskId,
        expires,
      );
      return true;
    });
  }

  releaseDesktopLock(sandboxId: string, taskId: string): void {
    this.run("DELETE FROM desktop_locks WHERE sandbox_id = ? AND task_id = ?", sandboxId, taskId);
  }

  findUserByName(name: string): User | undefined {
    const row = this.one<UserRow>("SELECT * FROM users WHERE name = ? ORDER BY created_at ASC LIMIT 1", name);
    return row ? mapUser(row) : undefined;
  }

  createSession(userId: string, skills: SkillCatalog, systemPrompt?: string): Session {
    const user = this.getUser(userId);
    if (!user) throw new Error(`unknown user ${userId}`);
    const prompt = systemPrompt ?? buildStablePrompt(skills.list());
    const createdAt = nowIso();
    const session: Session = {
      id: createId("ses"),
      userId,
      workspacePath: user.workspacePath,
      systemPrompt: prompt,
      title: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.run(
      `INSERT INTO sessions (id, user_id, workspace_path, system_prompt, transcript_json, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', NULL, ?, ?)`,
      session.id,
      session.userId,
      session.workspacePath,
      session.systemPrompt,
      session.createdAt,
      session.updatedAt,
    );
    return session;
  }

  getSession(id: string): Session | undefined {
    const row = this.one<SessionRow>("SELECT * FROM sessions WHERE id = ?", id);
    return row ? mapSession(row) : undefined;
  }

  latestSession(userId: string): Session | undefined {
    const row = this.one<SessionRow>(
      "SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1",
      userId,
    );
    return row ? mapSession(row) : undefined;
  }

  getTranscript(sessionId: string): AgentMessage[] {
    const row = this.one<{ transcript_json: string }>("SELECT transcript_json FROM sessions WHERE id = ?", sessionId);
    if (!row) throw new Error(`unknown session ${sessionId}`);
    return JSON.parse(row.transcript_json) as AgentMessage[];
  }

  setTranscript(sessionId: string, messages: AgentMessage[], title?: string, claim?: TaskClaim): boolean {
    const params: Sql[] = [JSON.stringify(messages), title ?? null, nowIso(), sessionId];
    let guard = "";
    if (claim) {
      guard = ` AND EXISTS (
        SELECT 1 FROM tasks
        WHERE tasks.id = ? AND tasks.session_id = sessions.id
          AND tasks.fence = ? AND tasks.worker_id = ? AND tasks.status = 'running'
          AND tasks.lease_until IS NOT NULL AND tasks.lease_until >= ?
      )`;
      params.push(claim.taskId, claim.fence, claim.workerId, nowIso());
    }
    const result = this.db
      .prepare(`UPDATE sessions SET transcript_json = ?, title = COALESCE(?, title), updated_at = ? WHERE id = ?${guard}`)
      .run(...params);
    return result.changes === 1;
  }

  enqueueTask(input: {
    sessionId: string;
    userId: string;
    prompt: string;
    kind?: TaskKind;
    parentId?: string;
    maxAttempts?: number;
    checkpoint?: TaskCheckpoint;
  }): Task {
    const task: Task = {
      id: createId("task"),
      sessionId: input.sessionId,
      userId: input.userId,
      parentId: input.parentId ?? null,
      kind: input.kind ?? "chat",
      status: "queued",
      prompt: input.prompt,
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 1,
      checkpoint: input.checkpoint ?? null,
      plan: null,
      goal: null,
      resultText: null,
      error: null,
      workerId: null,
      fence: 0,
      leaseUntil: null,
      heartbeatAt: null,
      firstResponseMs: null,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
    };
    this.run(
      `INSERT INTO tasks (
        id, session_id, user_id, parent_id, kind, status, prompt, attempt, max_attempts,
        checkpoint_json, plan_json, result_text, error, worker_id, first_response_ms, created_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL)`,
      task.id,
      task.sessionId,
      task.userId,
      task.parentId,
      task.kind,
      task.prompt,
      task.maxAttempts,
      task.checkpoint ? JSON.stringify(task.checkpoint) : null,
      task.createdAt,
    );
    return task;
  }

  claimTask(workerId: string, leaseMs = 15_000): Task | undefined {
    const started = nowIso();
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    const id = this.transaction(() => {
      const row = this.one<{ id: string }>(
        `SELECT id FROM tasks
         WHERE status = 'queued'
           AND session_id NOT IN (SELECT session_id FROM tasks WHERE status = 'running')
         ORDER BY created_at ASC
         LIMIT 1`,
      );
      if (!row) return undefined;
      const result = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'running', worker_id = ?, started_at = COALESCE(started_at, ?),
               fence = fence + 1, lease_until = ?, heartbeat_at = ?, finished_at = NULL
           WHERE id = ? AND status = 'queued'`,
        )
        .run(workerId, started, leaseUntil, started, row.id);
      return result.changes === 1 ? row.id : undefined;
    });
    return id ? this.getTask(id) : undefined;
  }

  renewLease(taskId: string, fence: number, workerId: string, leaseMs: number): boolean {
    const started = process.hrtime.bigint();
    const now = nowIso();
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET heartbeat_at = ?, lease_until = ?
         WHERE id = ? AND ${LIVE_LEASE}`,
      )
      .run(now, leaseUntil, taskId, fence, workerId, now);
    this.renews += 1;
    this.renewNs += Number(process.hrtime.bigint() - started);
    return result.changes === 1;
  }

  holdsLease(taskId: string, fence: number, workerId: string): boolean {
    const row = this.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE id = ? AND ${LIVE_LEASE}`,
      taskId,
      fence,
      workerId,
      nowIso(),
    );
    return (row?.n ?? 0) === 1;
  }

  expiredRunning(now: string): Task[] {
    return this.many<TaskRow>(
      `SELECT * FROM tasks
       WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)
       ORDER BY created_at ASC`,
      now,
    ).map(mapTask);
  }

  /**
   * Move an expired running task. The fence stays put so the old worker cannot write.
   * A renewed lease matches zero rows.
   */
  settleExpired(id: string, fence: number, decision: "requeue" | "inspect", now: string): boolean {
    const current = this.getTask(id);
    if (!current || current.status !== "running" || current.fence !== fence) return false;
    if (current.leaseUntil && current.leaseUntil >= now) return false;
    if (decision === "inspect") {
      const result = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'needs_inspection', error = ?, worker_id = NULL, lease_until = NULL, heartbeat_at = NULL, finished_at = ?
           WHERE id = ? AND fence = ? AND status = 'running' AND (lease_until IS NULL OR lease_until < ?)`,
        )
        .run("lease expired after an uncertain side effect", now, id, fence, now);
      return result.changes === 1;
    }
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'queued', error = ?, worker_id = NULL, lease_until = NULL, heartbeat_at = NULL, finished_at = NULL
         WHERE id = ? AND fence = ? AND status = 'running' AND (lease_until IS NULL OR lease_until < ?)`,
      )
      .run("lease expired before a durable side effect", id, fence, now);
    return result.changes === 1;
  }

  getTask(id: string): Task | undefined {
    const row = this.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
    return row ? mapTask(row) : undefined;
  }

  listSessionTasks(sessionId: string): Task[] {
    return this.many<TaskRow>("SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC", sessionId).map(mapTask);
  }

  countChildren(parentId: string): number {
    const row = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?", parentId);
    return row?.n ?? 0;
  }

  listChildren(parentId: string): Task[] {
    return this.many<TaskRow>("SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC", parentId).map(mapTask);
  }

  listByStatus(status: TaskStatus): Task[] {
    return this.many<TaskRow>("SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC", status).map(mapTask);
  }

  sessionBusy(sessionId: string): boolean {
    const row = this.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tasks WHERE session_id = ? AND status IN ('queued', 'running', 'waiting_children')",
      sessionId,
    );
    return (row?.n ?? 0) > 0;
  }

  countInFlight(): number {
    const row = this.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tasks WHERE status IN ('queued', 'running', 'waiting_children')",
    );
    return row?.n ?? 0;
  }

  markPaused(id: string, firstResponseMs?: number, claim?: TaskClaim): boolean {
    const params: Sql[] = [firstResponseMs ?? null, id];
    let guard = "";
    if (claim) {
      guard = ` AND fence = ? AND worker_id = ? AND lease_until IS NOT NULL AND lease_until >= ?`;
      params.push(claim.fence, claim.workerId, nowIso());
    }
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'waiting_approval', worker_id = NULL, lease_until = NULL, heartbeat_at = NULL,
             first_response_ms = COALESCE(?, first_response_ms)
         WHERE id = ? AND status = 'running'${guard}`,
      )
      .run(...params);
    return result.changes === 1;
  }

  finishTask(
    id: string,
    status: TaskStatus,
    patch: { resultText?: string; error?: string; firstResponseMs?: number } = {},
    claim?: TaskClaim,
  ): boolean {
    const current = this.getTask(id);
    const params: Sql[] = [status, patch.resultText ?? null, patch.error ?? null, patch.firstResponseMs ?? null, nowIso(), id];
    let guard = "";
    if (claim) {
      guard = ` AND fence = ? AND worker_id = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until >= ?`;
      params.push(claim.fence, claim.workerId, nowIso());
    }
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, result_text = COALESCE(?, result_text), error = ?, first_response_ms = COALESCE(?, first_response_ms),
             finished_at = ?, checkpoint_json = NULL, lease_until = NULL, heartbeat_at = NULL
         WHERE id = ?${guard}`,
      )
      .run(...params);
    if (result.changes !== 1) return false;
    if (current?.parentId) this.wakeParent(current.parentId);
    return true;
  }

  /** Park a running parent. Returns false when the row is no longer running. */
  markWaitingChildren(id: string, childIds: string[], firstResponseMs?: number, claim?: TaskClaim): boolean {
    const params: Sql[] = [JSON.stringify({ waitFor: childIds } satisfies TaskCheckpoint), firstResponseMs ?? null, id];
    let guard = "";
    if (claim) {
      guard = ` AND fence = ? AND worker_id = ? AND lease_until IS NOT NULL AND lease_until >= ?`;
      params.push(claim.fence, claim.workerId, nowIso());
    }
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'waiting_children', worker_id = NULL, lease_until = NULL, heartbeat_at = NULL, checkpoint_json = ?,
             first_response_ms = COALESCE(?, first_response_ms)
         WHERE id = ? AND status = 'running'${guard}`,
      )
      .run(...params);
    return result.changes === 1;
  }

  clearCheckpoint(id: string): void {
    this.run("UPDATE tasks SET checkpoint_json = NULL WHERE id = ?", id);
  }

  /**
   * Queue a parked parent once, only while every waited child is terminal.
   * A second caller sees status already changed and does nothing.
   */
  wakeParent(parentId: string): boolean {
    const parent = this.getTask(parentId);
    if (!parent || parent.status !== "waiting_children") return false;
    const ids = parent.checkpoint?.waitFor ?? [];
    if (ids.length === 0) return false;
    for (const id of ids) {
      const child = this.getTask(id);
      if (!child || OPEN_TASK.has(child.status)) return false;
    }
    const next: TaskCheckpoint = { resumeChildren: true, waitFor: ids };
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'queued', checkpoint_json = ?, error = NULL, worker_id = NULL, finished_at = NULL
         WHERE id = ? AND status = 'waiting_children'`,
      )
      .run(JSON.stringify(next), parentId);
    return result.changes === 1;
  }

  requeueTask(id: string, error: string, claim?: TaskClaim): boolean {
    const current = this.getTask(id);
    const keep =
      current?.checkpoint?.resumeChildren === true
        ? JSON.stringify({ resumeChildren: true, waitFor: current.checkpoint.waitFor ?? [] } satisfies TaskCheckpoint)
        : null;
    const params: Sql[] = [error, keep, id];
    let guard = "";
    if (claim) {
      guard = ` AND fence = ? AND worker_id = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until >= ?`;
      params.push(claim.fence, claim.workerId, nowIso());
    }
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'queued', attempt = attempt + 1, error = ?, worker_id = NULL, lease_until = NULL, heartbeat_at = NULL,
             finished_at = NULL, checkpoint_json = ?
         WHERE id = ?${guard}`,
      )
      .run(...params);
    return result.changes === 1;
  }

  resumeTask(id: string, checkpoint: TaskCheckpoint): void {
    this.run(
      `UPDATE tasks
       SET status = 'queued', checkpoint_json = ?, error = NULL, worker_id = NULL, lease_until = NULL,
           heartbeat_at = NULL, finished_at = NULL
       WHERE id = ?`,
      JSON.stringify(checkpoint),
      id,
    );
  }

  setPlan(taskId: string, plan: PlanStep[], claim?: TaskClaim): boolean {
    return this.writeOwned(taskId, "plan_json", JSON.stringify(plan), claim);
  }

  setGoal(taskId: string, goal: GoalPlan, claim?: TaskClaim): boolean {
    return this.writeOwned(taskId, "goal_json", JSON.stringify(goal), claim);
  }

  /**
   * Insert every child and the parent goal in one transaction.
   * A failed lease check writes nothing.
   */
  dispatchOwned(
    claim: TaskClaim,
    input: {
      userId: string;
      skills: SkillCatalog;
      systemPrompt: string;
      prompts: string[];
      goalFor?: (tasks: Task[]) => GoalPlan;
    },
  ): { tasks: Task[] } | { error: string } {
    if (input.prompts.length === 0) return { tasks: [] };
    for (const prompt of input.prompts) {
      if (prompt.length > 8_000) return { error: "prompt exceeds 8000 characters" };
    }
    try {
      return this.transaction(() => {
        if (!this.holdsLease(claim.taskId, claim.fence, claim.workerId)) {
          return { error: "worker lease is no longer held" };
        }
        if (this.countChildren(claim.taskId) + input.prompts.length > 8) {
          return { error: "child task limit reached" };
        }
        const tasks: Task[] = [];
        for (const prompt of input.prompts) {
          const session = this.createSession(input.userId, input.skills, input.systemPrompt);
          tasks.push(
            this.enqueueTask({
              sessionId: session.id,
              userId: input.userId,
              prompt,
              kind: "child",
              parentId: claim.taskId,
              maxAttempts: 1,
            }),
          );
        }
        if (input.goalFor) {
          const saved = this.setGoal(claim.taskId, input.goalFor(tasks), claim);
          if (!saved) throw new Error("lease lost during child dispatch");
        }
        return { tasks };
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message === "lease lost during child dispatch") return { error: "worker lease is no longer held" };
      throw caught;
    }
  }

  private writeOwned(taskId: string, column: "plan_json" | "goal_json", value: string, claim?: TaskClaim): boolean {
    if (!claim) {
      this.run(`UPDATE tasks SET ${column} = ? WHERE id = ?`, value, taskId);
      return true;
    }
    const result = this.db
      .prepare(`UPDATE tasks SET ${column} = ? WHERE id = ? AND ${LIVE_LEASE}`)
      .run(value, taskId, claim.fence, claim.workerId, nowIso());
    return result.changes === 1;
  }

  createApproval(input: {
    taskId: string;
    toolName: string;
    args: unknown;
    argsHash: string;
    risk: string;
    reason: string;
    claim?: TaskClaim;
  }): Approval {
    if (input.claim && !this.holdsLease(input.claim.taskId, input.claim.fence, input.claim.workerId)) {
      throw new Error("worker lease is no longer held");
    }
    const existing = this.one<ApprovalRow>(
      "SELECT * FROM approvals WHERE task_id = ? AND args_hash = ? AND status = 'pending' LIMIT 1",
      input.taskId,
      input.argsHash,
    );
    if (existing) return mapApproval(existing);
    const approval: Approval = {
      id: createId("apr"),
      taskId: input.taskId,
      toolName: input.toolName,
      args: input.args,
      argsHash: input.argsHash,
      risk: input.risk,
      status: "pending",
      reason: input.reason,
      createdAt: nowIso(),
      resolvedAt: null,
    };
    this.run(
      `INSERT INTO approvals (id, task_id, tool_name, args_json, args_hash, risk, status, reason, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
      approval.id,
      approval.taskId,
      approval.toolName,
      JSON.stringify(approval.args),
      approval.argsHash,
      approval.risk,
      approval.reason,
      approval.createdAt,
    );
    return approval;
  }

  listApprovals(taskId: string): Approval[] {
    return this.many<ApprovalRow>("SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at ASC", taskId).map(
      mapApproval,
    );
  }

  getApproval(id: string): Approval | undefined {
    const row = this.one<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", id);
    return row ? mapApproval(row) : undefined;
  }

  hasGrant(taskId: string, argsHash: string): boolean {
    const row = this.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM approvals WHERE task_id = ? AND args_hash = ? AND status = 'approved'",
      taskId,
      argsHash,
    );
    return (row?.n ?? 0) > 0;
  }

  resolveApproval(id: string, status: Extract<ApprovalStatus, "approved" | "denied">): Approval {
    const current = this.getApproval(id);
    if (!current) throw new Error(`unknown approval ${id}`);
    if (current.status !== "pending") return current;
    this.run("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?", status, nowIso(), id);
    const updated = this.getApproval(id);
    if (!updated) throw new Error(`unknown approval ${id}`);
    return updated;
  }

  createMemory(input: { userId: string; kind: MemoryKind; title: string; body: string }): Memory {
    const timestamp = nowIso();
    const memory: Memory = { id: createId("mem"), createdAt: timestamp, updatedAt: timestamp, ...input };
    this.run(
      `INSERT INTO memories (id, user_id, kind, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      memory.id,
      memory.userId,
      memory.kind,
      memory.title,
      memory.body,
      memory.createdAt,
      memory.updatedAt,
    );
    return memory;
  }

  listMemories(userId: string): Memory[] {
    return this.many<MemoryRow>("SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC", userId).map(
      mapMemory,
    );
  }

  getMemory(id: string): Memory | undefined {
    const row = this.one<MemoryRow>("SELECT * FROM memories WHERE id = ?", id);
    return row ? mapMemory(row) : undefined;
  }

  updateMemory(id: string, patch: { title?: string; body?: string; kind?: MemoryKind }): Memory {
    const current = this.getMemory(id);
    if (!current) throw new Error(`unknown memory ${id}`);
    const next = {
      title: patch.title ?? current.title,
      body: patch.body ?? current.body,
      kind: patch.kind ?? current.kind,
    };
    this.run(
      "UPDATE memories SET title = ?, body = ?, kind = ?, updated_at = ? WHERE id = ?",
      next.title,
      next.body,
      next.kind,
      nowIso(),
      id,
    );
    const updated = this.getMemory(id);
    if (!updated) throw new Error(`unknown memory ${id}`);
    return updated;
  }

  deleteMemory(id: string): void {
    this.run("DELETE FROM memories WHERE id = ?", id);
  }

  createAutomation(input: {
    userId: string;
    sessionId: string;
    kind: AutomationKind;
    name: string;
    schedule: string | null;
    webhookToken: string | null;
    prompt: string;
    nextRunAt: string | null;
  }): Automation {
    const automation: Automation = {
      id: createId("auto"),
      enabled: true,
      lastRunAt: null,
      createdAt: nowIso(),
      ...input,
    };
    this.run(
      `INSERT INTO automations (
        id, user_id, session_id, kind, name, schedule, webhook_token, prompt, enabled, last_run_at, next_run_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      automation.id,
      automation.userId,
      automation.sessionId,
      automation.kind,
      automation.name,
      automation.schedule,
      automation.webhookToken,
      automation.prompt,
      automation.nextRunAt,
      automation.createdAt,
    );
    return automation;
  }

  listAutomations(userId: string): Automation[] {
    return this.many<AutomationRow>("SELECT * FROM automations WHERE user_id = ? ORDER BY created_at ASC", userId).map(
      mapAutomation,
    );
  }

  dueAutomations(now: string): Automation[] {
    return this.many<AutomationRow>(
      `SELECT * FROM automations
       WHERE enabled = 1 AND schedule IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC`,
      now,
    ).map(mapAutomation);
  }

  getAutomationByToken(token: string): Automation | undefined {
    const row = this.one<AutomationRow>(
      "SELECT * FROM automations WHERE webhook_token = ? AND enabled = 1 AND kind = 'webhook'",
      token,
    );
    return row ? mapAutomation(row) : undefined;
  }

  markAutomation(id: string, nextRunAt: string, lastRunAt: string | null): void {
    this.run(
      "UPDATE automations SET next_run_at = ?, last_run_at = COALESCE(?, last_run_at) WHERE id = ?",
      nextRunAt,
      lastRunAt,
      id,
    );
  }

  addNotification(input: { userId: string; taskId?: string; title: string; body: string }): Notification {
    const notification: Notification = {
      id: createId("note"),
      userId: input.userId,
      taskId: input.taskId ?? null,
      title: input.title,
      body: input.body,
      readAt: null,
      createdAt: nowIso(),
    };
    this.run(
      `INSERT INTO notifications (id, user_id, task_id, title, body, read_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      notification.id,
      notification.userId,
      notification.taskId,
      notification.title,
      notification.body,
      notification.createdAt,
    );
    return notification;
  }

  listNotifications(userId: string): Notification[] {
    return this.many<NotificationRow>(
      "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC",
      userId,
    ).map(mapNotification);
  }

  getNotification(id: string): Notification | undefined {
    const row = this.one<NotificationRow>("SELECT * FROM notifications WHERE id = ?", id);
    return row ? mapNotification(row) : undefined;
  }

  markNotificationRead(id: string): void {
    this.run("UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL", nowIso(), id);
  }

  addTrace(input: {
    taskId: string;
    kind: string;
    name: string;
    startedAt: string;
    endedAt?: string;
    data: unknown;
    claim?: TaskClaim;
  }): TraceEvent | undefined {
    const event: TraceEvent = {
      id: createId("trace"),
      taskId: input.taskId,
      kind: input.kind,
      name: input.name,
      startedAt: input.startedAt,
      endedAt: input.endedAt ?? null,
      data: input.data,
    };
    if (input.claim && input.claim.taskId !== input.taskId) return undefined;
    if (!input.claim) {
      this.run(
        `INSERT INTO traces (id, task_id, kind, name, started_at, ended_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        event.id,
        event.taskId,
        event.kind,
        event.name,
        event.startedAt,
        event.endedAt,
        JSON.stringify(event.data),
      );
      return event;
    }
    const result = this.db
      .prepare(
        `INSERT INTO traces (id, task_id, kind, name, started_at, ended_at, data_json)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND ${LIVE_LEASE})`,
      )
      .run(
        event.id,
        event.taskId,
        event.kind,
        event.name,
        event.startedAt,
        event.endedAt,
        JSON.stringify(event.data),
        input.claim.taskId,
        input.claim.fence,
        input.claim.workerId,
        nowIso(),
      );
    return result.changes === 1 ? event : undefined;
  }

  listTraces(taskId: string): TraceEvent[] {
    return this.many<TraceRow>("SELECT * FROM traces WHERE task_id = ? ORDER BY started_at ASC", taskId).map(mapTrace);
  }

  addUsage(input: Omit<UsageEvent, "id" | "createdAt"> & { claim?: TaskClaim }): UsageEvent | undefined {
    const { claim, ...rest } = input;
    if (claim && !this.holdsLease(claim.taskId, claim.fence, claim.workerId)) return undefined;
    const event: UsageEvent = { id: createId("usage"), createdAt: nowIso(), ...rest };
    this.run(
      `INSERT INTO usage_events (
        id, task_id, turn_index, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id,
      event.taskId,
      event.turnIndex,
      event.inputTokens,
      event.outputTokens,
      event.cacheReadTokens,
      event.cacheWriteTokens,
      event.costUsd,
      event.createdAt,
    );
    return event;
  }

  listUsage(taskId: string): UsageEvent[] {
    return this.many<UsageEventRow>(
      "SELECT * FROM usage_events WHERE task_id = ? ORDER BY turn_index ASC, created_at ASC",
      taskId,
    ).map(mapUsage);
  }

  usageSummary(taskId: string): UsageSummary {
    return summarizeUsage(this.many<UsageRow>("SELECT * FROM usage_events WHERE task_id = ? ORDER BY turn_index ASC", taskId));
  }

  usageForUser(userId: string): UsageSummary {
    return summarizeUsage(
      this.many<UsageRow>(
        `SELECT usage_events.input_tokens, usage_events.output_tokens, usage_events.cache_read_tokens,
                usage_events.cache_write_tokens, usage_events.cost_usd
         FROM usage_events JOIN tasks ON tasks.id = usage_events.task_id
         WHERE tasks.user_id = ?`,
        userId,
      ),
    );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        workspace_path TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        transcript_json TEXT NOT NULL DEFAULT '[]',
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        parent_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        checkpoint_json TEXT,
        plan_json TEXT,
        result_text TEXT,
        error TEXT,
        worker_id TEXT,
        first_response_ms INTEGER,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        schedule TEXT,
        webhook_token TEXT UNIQUE,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        task_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        read_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        turn_index INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_automations_next ON automations(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS credentials (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        user_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS computers (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        sandbox_id TEXT,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        machine_type TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        snapshot_id TEXT,
        snapshot_status TEXT,
        retention_note TEXT NOT NULL,
        last_error TEXT,
        last_used_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_locks (
        sandbox_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    this.addColumn("tasks", "goal_json", "TEXT");
    this.addColumn("tasks", "fence", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("tasks", "lease_until", "TEXT");
    this.addColumn("tasks", "heartbeat_at", "TEXT");
  }

  private transaction<T>(fn: () => T): T {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
      } catch (caught) {
        if (isBusy(caught) && attempt < 5) {
          this.lockWaits += 1;
          continue;
        }
        throw caught;
      }
      try {
        const value = fn();
        this.db.exec("COMMIT");
        return value;
      } catch (caught) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // The connection may already have left the transaction.
        }
        if (isBusy(caught) && attempt < 5) {
          this.lockWaits += 1;
          continue;
        }
        throw caught;
      }
    }
    throw new Error("sqlite lock was not acquired");
  }

  private addColumn(table: string, name: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === name)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }

  private one<T>(sql: string, ...params: Sql[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private many<T>(sql: string, ...params: Sql[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: Sql[]): void {
    this.db.prepare(sql).run(...params);
  }

  private changes(sql: string, ...params: Sql[]): number {
    const result = this.db.prepare(sql).run(...params) as { changes?: number };
    return result.changes ?? 0;
  }

  private claimStaleComputer(row: ComputerBinding): boolean {
    if (Date.now() - Date.parse(row.updatedAt) < 30_000) return false;
    const now = nowIso();
    return (
      this.changes(
        "UPDATE computers SET updated_at = ? WHERE user_id = ? AND status = 'creating' AND sandbox_id IS NULL AND updated_at = ?",
        now,
        row.userId,
        row.updatedAt,
      ) > 0
    );
  }
}

interface UserRow {
  id: string;
  name: string;
  workspace_path: string;
  created_at: string;
}
interface SessionRow {
  id: string;
  user_id: string;
  workspace_path: string;
  system_prompt: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}
interface TaskRow {
  id: string;
  session_id: string;
  user_id: string;
  parent_id: string | null;
  kind: TaskKind;
  status: TaskStatus;
  prompt: string;
  attempt: number;
  max_attempts: number;
  checkpoint_json: string | null;
  plan_json: string | null;
  goal_json: string | null;
  result_text: string | null;
  error: string | null;
  worker_id: string | null;
  fence: number;
  lease_until: string | null;
  heartbeat_at: string | null;
  first_response_ms: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
interface ApprovalRow {
  id: string;
  task_id: string;
  tool_name: string;
  args_json: string;
  args_hash: string;
  risk: string;
  status: ApprovalStatus;
  reason: string;
  created_at: string;
  resolved_at: string | null;
}
interface MemoryRow {
  id: string;
  user_id: string;
  kind: MemoryKind;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}
interface AutomationRow {
  id: string;
  user_id: string;
  session_id: string;
  kind: AutomationKind;
  name: string;
  schedule: string | null;
  webhook_token: string | null;
  prompt: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}
interface NotificationRow {
  id: string;
  user_id: string;
  task_id: string | null;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
}
interface TraceRow {
  id: string;
  task_id: string;
  kind: string;
  name: string;
  started_at: string;
  ended_at: string | null;
  data_json: string;
}
function summarizeUsage(rows: UsageRow[]): UsageSummary {
  const summary: UsageSummary = {
    turns: rows.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    cacheHitRatio: 0,
  };
  for (const row of rows) {
    summary.inputTokens += row.input_tokens;
    summary.outputTokens += row.output_tokens;
    summary.cacheReadTokens += row.cache_read_tokens;
    summary.cacheWriteTokens += row.cache_write_tokens;
    summary.costUsd += row.cost_usd;
  }
  summary.cacheHitRatio = cacheHitRatio(summary);
  return summary;
}

interface UsageRow {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}
interface UsageEventRow extends UsageRow {
  id: string;
  task_id: string;
  turn_index: number;
  created_at: string;
}

function mapUser(row: UserRow): User {
  return { id: row.id, name: row.name, workspacePath: row.workspace_path, createdAt: row.created_at };
}
function mapSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    workspacePath: row.workspace_path,
    systemPrompt: row.system_prompt,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    parentId: row.parent_id,
    kind: row.kind,
    status: row.status,
    prompt: row.prompt,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    checkpoint: row.checkpoint_json ? (JSON.parse(row.checkpoint_json) as TaskCheckpoint) : null,
    plan: row.plan_json ? (JSON.parse(row.plan_json) as PlanStep[]) : null,
    goal: row.goal_json ? (JSON.parse(row.goal_json) as GoalPlan) : null,
    resultText: row.result_text,
    error: row.error,
    workerId: row.worker_id,
    fence: row.fence ?? 0,
    leaseUntil: row.lease_until,
    heartbeatAt: row.heartbeat_at,
    firstResponseMs: row.first_response_ms,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
function mapApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    taskId: row.task_id,
    toolName: row.tool_name,
    args: JSON.parse(row.args_json) as unknown,
    argsHash: row.args_hash,
    risk: row.risk,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}
function mapMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    kind: row.kind,
    name: row.name,
    schedule: row.schedule,
    webhookToken: row.webhook_token,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
  };
}
function isBusy(caught: unknown): boolean {
  const message = caught instanceof Error ? caught.message : String(caught);
  return /SQLITE_BUSY|database is locked/i.test(message);
}

function isConstraint(caught: unknown): boolean {
  const message = caught instanceof Error ? caught.message : String(caught);
  return /SQLITE_CONSTRAINT|UNIQUE constraint failed/i.test(message);
}

interface ComputerRow {
  user_id: string;
  sandbox_id: string | null;
  status: ComputerBinding["status"];
  idempotency_key: string;
  machine_type: string;
  workspace_path: string;
  snapshot_id: string | null;
  snapshot_status: string | null;
  retention_note: string;
  last_error: string | null;
  last_used_at: string;
  created_at: string;
  updated_at: string;
}

function mapComputer(row: ComputerRow): ComputerBinding {
  return {
    userId: row.user_id,
    sandboxId: row.sandbox_id,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    machineType: row.machine_type,
    workspacePath: row.workspace_path,
    snapshotId: row.snapshot_id,
    snapshotStatus: row.snapshot_status,
    retentionNote: row.retention_note,
    lastError: row.last_error,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    taskId: row.task_id,
    title: row.title,
    body: row.body,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}
function mapUsage(row: UsageEventRow): UsageEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    turnIndex: row.turn_index,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
  };
}
function mapTrace(row: TraceRow): TraceEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    name: row.name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    data: JSON.parse(row.data_json) as unknown,
  };
}

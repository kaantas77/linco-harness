import path from "node:path";
import { Agent, type AgentMessage, type BeforeToolCallContext, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { intervalSchedule, nextScheduleRun } from "../automation/cron.js";
import type { LincoConfig } from "../config.js";
import { LincoDb } from "../db/database.js";
import { createId } from "../ids.js";
import { clip } from "../json.js";
import { createDeepSeek } from "../llm/deepseek.js";
import { SCRIPT_MODEL } from "../llm/scripted.js";
import { compactForRequest } from "../prompt/compact.js";
import { composeUserMessage, selectMemories } from "../prompt/layout.js";
import { approvalHash, assess } from "../security/policy.js";
import { SkillCatalog } from "../skills/catalog.js";
import { closeTaskBrowser } from "../browser/session.js";
import { browserPrompt, toolsForPrompt } from "../tools/toolset.js";
import { HttpBrowserProvider } from "../tools/http-browser.js";
import type { ToolHost } from "../tools/host.js";
import { LocalComputerProvider } from "../tools/local-computer.js";
import type { Automation, AutomationKind, Task, TaskKind, User } from "../types.js";
import { lastAssistantText } from "./transcript.js";

export interface HarnessOptions {
  config: LincoConfig;
  streamFn?: StreamFn;
  model?: Model<Api>;
}

export class Harness {
  readonly config: LincoConfig;
  readonly db: LincoDb;
  readonly skills: SkillCatalog;
  private readonly computer = new LocalComputerProvider();
  private readonly browser = new HttpBrowserProvider();
  private streamFn: StreamFn | undefined;
  private model: Model<Api> | undefined;
  private running = false;
  private readonly workerLoops: Promise<void>[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | undefined;

  constructor(options: HarnessOptions) {
    this.config = options.config;
    this.db = new LincoDb(path.join(options.config.dataDir, "linco.sqlite"));
    this.skills = new SkillCatalog(options.config.skillsDir);
    this.streamFn = options.streamFn;
    this.model = options.model;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (let index = 0; index < this.config.workerCount; index += 1) {
      this.workerLoops.push(this.loop(`worker_${index + 1}`));
    }
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        // A bad schedule should not kill the pool. The next tick tries again.
      }
    }, this.config.schedulerIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    for (const abort of this.aborts.values()) abort.abort();
    await Promise.allSettled([...this.inflight, ...this.workerLoops]);
    this.db.close();
  }

  createUser(name: string): User {
    return this.db.createUser(name, this.config.dataDir);
  }

  createSession(userId: string) {
    return this.db.createSession(userId, this.skills, browserPrompt(this.skills.list()));
  }

  async submit(
    sessionId: string,
    prompt: string,
    options: { kind?: TaskKind; maxAttempts?: number; waitMs?: number; parentId?: string } = {},
  ): Promise<Task> {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const task = this.db.enqueueTask({
      sessionId,
      userId: session.userId,
      prompt,
      kind: options.kind ?? "chat",
      maxAttempts: options.maxAttempts ?? 1,
      parentId: options.parentId,
    });
    if (!options.waitMs) return task;
    return this.waitForTask(task.id, options.waitMs);
  }

  cancel(taskId: string): Task {
    const task = this.requireTask(taskId);
    if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") return task;
    this.aborts.get(taskId)?.abort();
    if (task.status !== "running") this.db.finishTask(taskId, "cancelled", { error: "cancelled" });
    return this.requireTask(taskId);
  }

  approve(taskId: string, approvalId: string, decision: "approved" | "denied"): Task {
    const approval = this.db.getApproval(approvalId);
    if (!approval || approval.taskId !== taskId) throw new Error(`unknown approval ${approvalId}`);
    if (decision === "denied") {
      this.db.resolveApproval(approvalId, "denied");
      this.db.finishTask(taskId, "failed", { error: "user denied approval" });
      return this.requireTask(taskId);
    }
    const granted = this.db.resolveApproval(approvalId, "approved");
    this.db.resumeTask(taskId, {
      continuation: [
        "The user approved this action. Retry only this action.",
        `tool: ${granted.toolName}`,
        `arguments: ${JSON.stringify(granted.args)}`,
      ].join("\n"),
    });
    return this.requireTask(taskId);
  }

  createAutomation(input: {
    userId: string;
    kind: AutomationKind;
    name: string;
    prompt: string;
    schedule?: string;
    everyMs?: number;
  }): Automation {
    const session = this.createSession(input.userId);
    const webhookToken = input.kind === "webhook" ? createId("hook") : null;
    let schedule: string | null = null;
    let nextRunAt: string | null = null;
    if (input.kind === "cron") {
      if (!input.schedule) throw new Error("cron schedule is required");
      schedule = input.schedule;
      nextRunAt = nextScheduleRun(schedule, new Date()).toISOString();
    } else if (input.kind === "heartbeat") {
      schedule = intervalSchedule(input.everyMs ?? 0);
      nextRunAt = nextScheduleRun(schedule, new Date()).toISOString();
    }
    return this.db.createAutomation({
      userId: input.userId,
      sessionId: session.id,
      kind: input.kind,
      name: input.name,
      schedule,
      webhookToken,
      prompt: input.prompt,
      nextRunAt,
    });
  }

  acceptWebhook(token: string, payload: unknown): Task {
    const automation = this.db.getAutomationByToken(token);
    if (!automation) throw new Error("unknown webhook");
    const encoded = JSON.stringify(payload ?? null);
    const prompt = automation.prompt.includes("{{payload}}")
      ? automation.prompt.replaceAll("{{payload}}", encoded)
      : `${automation.prompt}\n\n<webhook-payload>\n${encoded}\n</webhook-payload>`;
    return this.db.enqueueTask({
      sessionId: automation.sessionId,
      userId: automation.userId,
      prompt,
      kind: "webhook",
      maxAttempts: 2,
    });
  }

  tick(now = new Date()): number {
    let queued = 0;
    for (const job of this.db.dueAutomations(now.toISOString())) {
      if (!job.schedule) continue;
      if (this.db.sessionBusy(job.sessionId)) {
        this.db.markAutomation(job.id, new Date(now.getTime() + 30_000).toISOString(), null);
        continue;
      }
      const kind: TaskKind = job.kind === "heartbeat" ? "heartbeat" : "cron";
      this.db.enqueueTask({
        sessionId: job.sessionId,
        userId: job.userId,
        prompt: job.prompt,
        kind,
        maxAttempts: 2,
      });
      this.db.markAutomation(job.id, nextScheduleRun(job.schedule, now).toISOString(), now.toISOString());
      queued += 1;
    }
    return queued;
  }

  async waitForTask(taskId: string, timeoutMs: number): Promise<Task> {
    const started = Date.now();
    for (;;) {
      const task = this.requireTask(taskId);
      if (task.status !== "queued" && task.status !== "running") return task;
      if (Date.now() - started > timeoutMs) return task;
      await sleep(20);
    }
  }

  async drain(timeoutMs = 5_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.db.countInFlight() === 0) return;
      await sleep(20);
    }
    throw new Error("timed out waiting for tasks");
  }

  private async loop(workerId: string): Promise<void> {
    while (this.running) {
      const task = this.db.claimTask(workerId);
      if (!task) {
        await sleep(30);
        continue;
      }
      const run = this.execute(workerId, task);
      this.inflight.add(run);
      try {
        await run;
      } finally {
        this.inflight.delete(run);
      }
    }
  }

  private async execute(_workerId: string, task: Task): Promise<void> {
    const abort = new AbortController();
    this.aborts.set(task.id, abort);
    const run = { waitingApproval: false, firstResponseMs: undefined as number | undefined, turn: 0 };
    const started = Date.now();
    let agent: Agent | undefined;
    try {
      const session = this.db.getSession(task.sessionId);
      if (!session) throw new Error(`missing session ${task.sessionId}`);
      const llm = await this.llm();
      const host: ToolHost = {
        workspaceRoot: session.workspacePath,
        taskId: task.id,
        userId: task.userId,
        sessionId: session.id,
        parentTaskId: task.parentId,
        systemPrompt: session.systemPrompt,
        db: this.db,
        skills: this.skills,
        browser: this.browser,
        computer: this.computer,
        signal: abort.signal,
        markApproval: () => {
          run.waitingApproval = true;
        },
      };
      const tools = toolsForPrompt(host, session.systemPrompt);
      const transcript = this.db.getTranscript(session.id);
      const budget = { turns: 0 };
      agent = new Agent({
        initialState: {
          model: llm.model,
          tools,
          ...(this.config.thinkingLevel ? { thinkingLevel: this.config.thinkingLevel } : {}),
          ...(transcript.length === 0 ? { systemPrompt: session.systemPrompt } : { messages: transcript }),
        },
        streamFn: llm.streamFn,
        sessionId: session.id,
        toolExecution: "parallel",
        getApiKey: async () => this.config.apiKey,
        identity: {
          attribution: { name: "Linco", url: "https://linco.local", categories: ["cli-agent"] },
          userAgent: { custom: "linco-harness/0.1.0" },
        },
        beforeToolCall: async (context) => this.gate(host, context),
        finishTurn: () => {
          budget.turns += 1;
          if (run.waitingApproval || budget.turns >= this.config.maxTurns) return { action: "end" };
          return undefined;
        },
        transformContext: async (messages: AgentMessage[]) =>
          compactForRequest(messages, { maxChars: this.config.compactMaxChars }),
      });
      agent.subscribe((event) => {
        if (event.type === "message_start" && event.message.role === "assistant" && run.firstResponseMs === undefined) {
          run.firstResponseMs = Date.now() - started;
        }
        if (event.type === "message_end" && event.message.role === "assistant" && "usage" in event.message) {
          const usage = event.message.usage;
          this.db.addUsage({
            taskId: task.id,
            turnIndex: run.turn,
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            costUsd: usage.cost.total,
          });
          run.turn += 1;
        }
        if (event.type === "tool_execution_end") {
          const ended = Date.now();
          this.db.addTrace({
            taskId: task.id,
            kind: "tool",
            name: event.toolName,
            startedAt: new Date(ended - (event.durationMs ?? 0)).toISOString(),
            endedAt: new Date(ended).toISOString(),
            data: { isError: event.isError, durationMs: event.durationMs ?? null },
          });
        }
      });
      const prompt = task.checkpoint?.continuation
        ? task.checkpoint.continuation
        : composeUserMessage(task.prompt, {
            workspace: session.workspacePath,
            now: new Date().toISOString(),
            memories: selectMemories(this.db.listMemories(task.userId), task.prompt).map((memory) => ({
              title: memory.title,
              body: memory.body,
            })),
          });
      await agent.prompt(prompt);
      this.persist(agent, session.id, task.prompt);
      if (abort.signal.aborted) {
        this.db.finishTask(task.id, "cancelled", { error: "cancelled", firstResponseMs: run.firstResponseMs });
        return;
      }
      if (run.waitingApproval) {
        this.db.markPaused(task.id, run.firstResponseMs);
        this.notify(task, "Onay bekleniyor", "Bir araç kullanıcı onayı olmadan çalışmadı.");
        return;
      }
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
      const result = lastAssistantText(agent.state.messages);
      this.db.finishTask(task.id, "succeeded", { resultText: result, firstResponseMs: run.firstResponseMs });
      if (task.kind === "cron" || task.kind === "heartbeat" || task.kind === "webhook") {
        this.notify(task, "Görev bitti", result || task.prompt);
      }
    } catch (caught) {
      if (agent) {
        const sessionId = task.sessionId;
        try {
          this.persist(agent, sessionId, task.prompt);
        } catch {
          // The original failure is the one to record.
        }
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      if (abort.signal.aborted) {
        this.db.finishTask(task.id, "cancelled", { error: message, firstResponseMs: run.firstResponseMs });
        return;
      }
      const current = this.db.getTask(task.id);
      if (current && current.attempt + 1 < current.maxAttempts) {
        this.db.requeueTask(task.id, message);
        return;
      }
      this.db.finishTask(task.id, "failed", { error: message, firstResponseMs: run.firstResponseMs });
      if (task.kind === "cron" || task.kind === "heartbeat" || task.kind === "webhook") {
        this.notify(task, "Görev hata verdi", message);
      }
    } finally {
      await closeTaskBrowser(task.id);
      this.aborts.delete(task.id);
    }
  }

  private gate(host: ToolHost, context: BeforeToolCallContext) {
    const assessment = assess(context.toolCall.name, context.args, host.workspaceRoot);
    if (assessment.action === "allow") return undefined;
    if (assessment.action === "deny") return { block: true, reason: assessment.reason };
    const hash = approvalHash(context.toolCall.name, context.args);
    if (host.db.hasGrant(host.taskId, hash)) return undefined;
    host.db.createApproval({
      taskId: host.taskId,
      toolName: context.toolCall.name,
      args: context.args,
      argsHash: hash,
      risk: assessment.risk,
      reason: assessment.reason,
    });
    host.markApproval();
    return { block: true, terminate: true, reason: assessment.reason };
  }

  private persist(agent: Agent, sessionId: string, prompt: string): void {
    this.db.setTranscript(sessionId, agent.state.messages, prompt.slice(0, 80));
  }

  private async llm(): Promise<{ model: Model<Api>; streamFn: StreamFn }> {
    if (this.streamFn) return { model: this.model ?? SCRIPT_MODEL, streamFn: this.streamFn };
    const created = createDeepSeek(this.config.model);
    this.model = created.model;
    this.streamFn = created.streamFn;
    return created;
  }

  private notify(task: Task, title: string, body: string): void {
    this.db.addNotification({ userId: task.userId, taskId: task.id, title, body: clip(body, 500) });
  }

  private requireTask(taskId: string): Task {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    return task;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

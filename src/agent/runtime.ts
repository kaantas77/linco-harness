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
import { planContext } from "../prompt/compact.js";
import { composeUserMessage, selectMemories } from "../prompt/layout.js";
import { loopbackHost } from "../config.js";
import { hashToken, newToken } from "../security/tokens.js";
import { approvalHash, assess } from "../security/policy.js";
import { bindBoat } from "../boat/bind.js";
import { createBoatClient } from "../boat/client.js";
import { BoatSandboxManager } from "../boat/manager.js";
import { modelAcceptsImages } from "../boat/vision.js";
import { SkillCatalog } from "../skills/catalog.js";
import { attributeParentTool, goalSuccessBlock } from "./goal.js";
import { contractForPrompt, missingEvidence } from "./evidence.js";
import { recoveryDecision } from "./lease.js";
import { routeExecution, type ToolProfile } from "./route.js";
import { childReport, dropTrailingAssistantError, rewriteWaitResults } from "./children.js";
import { closeJevTask } from "../browser/jev-delegation.js";
import { closeTaskBrowser } from "../browser/session.js";
import { browserPrompt, toolsForPrompt, withBoatComputer } from "../tools/toolset.js";
import { HttpBrowserProvider } from "../tools/http-browser.js";
import type { ToolHost } from "../tools/host.js";
import { localFiles } from "../tools/local-files.js";
import { LocalComputerProvider } from "../tools/local-computer.js";
import type { Automation, AutomationKind, Task, TaskClaim, TaskKind, User } from "../types.js";
import { lastAssistantText } from "./transcript.js";

export interface HarnessOptions {
  config: LincoConfig;
  streamFn?: StreamFn;
  model?: Model<Api>;
  /** Test double. Production builds the Boat client from BOAT_API_KEY. */
  boat?: BoatSandboxManager;
  /** How long to wait for a Boat sandbox to become ready. */
  boatReadyTimeoutMs?: number;
}

export class Harness {
  readonly config: LincoConfig;
  readonly db: LincoDb;
  readonly skills: SkillCatalog;
  readonly bootstrapToken: string | null;
  private readonly boat: BoatSandboxManager | null;
  private readonly computer: LocalComputerProvider;
  private readonly browser: HttpBrowserProvider;
  private streamFn: StreamFn | undefined;
  private model: Model<Api> | undefined;
  private running = false;
  private readonly workerLoops: Promise<void>[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | undefined;
  private leaseTimer: NodeJS.Timeout | undefined;

  constructor(options: HarnessOptions) {
    this.config = options.config;
    if (this.config.authMode === "dev" && !loopbackHost(this.config.host)) {
      throw new Error("LINCO_AUTH=dev only binds to loopback");
    }
    this.db = new LincoDb(path.join(options.config.dataDir, "linco.sqlite"));
    this.skills = new SkillCatalog(options.config.skillsDir);
    this.computer = new LocalComputerProvider(this.config.sandbox);
    this.browser = new HttpBrowserProvider({ allowLoopback: this.config.allowLoopback });
    if (options.boat) {
      this.boat = options.boat;
    } else if (this.config.computer === "boat") {
      if (!this.config.boatApiKey) throw new Error("BOAT_API_KEY is not set");
      this.boat = new BoatSandboxManager({
        client: createBoatClient({ apiKey: this.config.boatApiKey, basePath: this.config.boatBaseUrl }),
        db: this.db,
        machineType: this.config.boatMachineType,
        ttlSeconds: this.config.boatTtlSeconds,
        idleStopMs: this.config.boatIdleStopMs,
        maxSeconds: this.config.boatMaxSeconds,
        allowLoopback: this.config.allowLoopback,
        ...(options.boatReadyTimeoutMs ? { readyTimeoutMs: options.boatReadyTimeoutMs } : {}),
      });
    } else {
      this.boat = null;
    }
    this.streamFn = options.streamFn;
    this.model = options.model;
    if (this.config.authMode === "token" && this.config.manageCredentials) {
      this.bootstrapToken = this.config.bootstrapToken ?? newToken();
      this.db.replaceBootstrap(hashToken(this.bootstrapToken));
    } else {
      this.bootstrapToken = this.config.bootstrapToken ?? null;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.sweep();
    for (let index = 0; index < this.config.workerCount; index += 1) {
      this.workerLoops.push(this.loop(`worker_${process.pid}_${index + 1}`));
    }
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        // A bad schedule should not kill the pool. The next tick tries again.
      }
    }, this.config.schedulerIntervalMs);
    this.timer.unref?.();
    this.leaseTimer = setInterval(() => {
      try {
        this.sweep();
      } catch {
        // A locked database retries on the next sweep.
      }
    }, Math.max(50, Math.floor(this.config.leaseMs / 3)));
    this.leaseTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    for (const abort of this.aborts.values()) abort.abort();
    await Promise.allSettled([...this.inflight, ...this.workerLoops]);
    this.db.close();
  }

  createUser(name: string): User {
    return this.db.createUser(name, this.config.dataDir);
  }

  createSession(userId: string) {
    const base = browserPrompt(this.skills.list());
    const prompt = this.config.computer === "boat" ? withBoatComputer(base) : base;
    return this.db.createSession(userId, this.skills, prompt);
  }

  computerStatus(userId: string) {
    if (!this.boat) {
      const user = this.db.getUser(userId);
      return { mode: "local" as const, workspacePath: user?.workspacePath ?? null };
    }
    return this.boat.describe(userId);
  }

  async ensureComputer(userId: string) {
    if (!this.boat) return this.computerStatus(userId);
    await this.boat.ensure(userId);
    return this.boat.describe(userId);
  }

  async submit(
    sessionId: string,
    prompt: string,
    options: { kind?: TaskKind; maxAttempts?: number; waitMs?: number; parentId?: string; toolProfile?: "auto" | ToolProfile } = {},
  ): Promise<Task> {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const toolProfile = options.toolProfile === "auto" ? routeExecution(prompt).profile : options.toolProfile;
    const task = this.db.enqueueTask({
      sessionId,
      userId: session.userId,
      prompt,
      kind: options.kind ?? "chat",
      maxAttempts: options.maxAttempts ?? 1,
      parentId: options.parentId,
      checkpoint: toolProfile ? { toolProfile } : undefined,
    });
    if (!options.waitMs) return task;
    return this.waitForTask(task.id, options.waitMs);
  }

  cancel(taskId: string): Task {
    const task = this.requireTask(taskId);
    if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") return task;
    this.aborts.get(taskId)?.abort();
    if (task.status !== "running") this.db.finishTask(taskId, "cancelled", { error: "cancelled" });
    for (const child of this.db.listChildren(taskId)) {
      if (child.status === "succeeded" || child.status === "failed" || child.status === "cancelled") continue;
      this.cancel(child.id);
    }
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
      if (task.status !== "queued" && task.status !== "running" && task.status !== "waiting_children") return task;
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
      const task = this.db.claimTask(workerId, this.config.leaseMs);
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

  private sweep(): void {
    const now = new Date().toISOString();
    for (const parent of this.db.listByStatus("waiting_children")) this.db.wakeParent(parent.id);
    for (const task of this.db.expiredRunning(now)) {
      const decision = recoveryDecision(this.db.listTraces(task.id));
      if (!this.db.settleExpired(task.id, task.fence, decision, now)) continue;
      if (decision === "inspect") {
        for (const child of this.db.listChildren(task.id)) {
          if (child.status === "queued") this.db.finishTask(child.id, "cancelled", { error: "parent needs inspection" });
        }
      }
      if (task.parentId) this.db.wakeParent(task.parentId);
      const at = new Date().toISOString();
      this.db.addTrace({
        taskId: task.id,
        kind: "recovery",
        name: decision,
        startedAt: at,
        endedAt: at,
        data: { fence: task.fence, workerId: task.workerId },
      });
    }
    if (this.boat) void this.boat.reapIdle().catch(() => undefined);
  }

  private async execute(workerId: string, task: Task): Promise<void> {
    const claim: TaskClaim = { taskId: task.id, fence: task.fence, workerId };
    const abort = new AbortController();
    this.aborts.set(task.id, abort);
    const beat = setInterval(() => {
      if (!this.db.renewLease(task.id, task.fence, workerId, this.config.leaseMs)) abort.abort();
    }, Math.max(50, this.config.heartbeatMs));
    beat.unref?.();
    const run = { waitingApproval: false, firstResponseMs: task.firstResponseMs ?? undefined, turn: 0 };
    const waiting = new Set<string>();
    const started = Date.now();
    let agent: Agent | undefined;
    let resumeChildren = false;
    try {
      const session = this.db.getSession(task.sessionId);
      if (!session) throw new Error(`missing session ${task.sessionId}`);
      resumeChildren = task.checkpoint?.resumeChildren === true;
      let transcript = this.db.getTranscript(session.id);
      if (resumeChildren) {
        transcript = rewriteWaitResults(transcript, (childId) => {
          const child = this.db.getTask(childId);
          if (!child || child.userId !== task.userId || child.parentId !== task.id) return undefined;
          return childReport(this.db, child);
        });
        if (!this.db.setTranscript(session.id, transcript, task.prompt.slice(0, 80), claim)) {
          throw new Error("stale worker lost the transcript fence");
        }
        this.db.addTrace({
          taskId: task.id,
          kind: "orchestration",
          name: "resume",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          data: { childIds: task.checkpoint?.waitFor ?? [] },
          claim,
        });
      }
      const llm = await this.llm();
      if (this.boat) await this.boat.ensure(task.userId);
      const bound = this.boat ? bindBoat(this.boat, { userId: task.userId, taskId: task.id, acceptsImages: modelAcceptsImages(llm.model) }) : undefined;
      const workspaceRoot = bound?.workspacePath ?? session.workspacePath;
      const host: ToolHost = {
        workspaceRoot,
        taskId: task.id,
        userId: task.userId,
        sessionId: session.id,
        parentTaskId: task.parentId,
        systemPrompt: session.systemPrompt,
        db: this.db,
        skills: this.skills,
        browser: bound?.browser ?? this.browser,
        computer: bound?.computer ?? this.computer,
        files: bound?.files ?? localFiles(session.workspacePath),
        ...(bound ? { desktop: bound.desktop, vmBrowser: bound.vmBrowser } : {}),
        ...(task.checkpoint?.toolProfile ? { toolProfile: task.checkpoint.toolProfile } : {}),
        signal: abort.signal,
        claim,
        allowLoopback: this.config.allowLoopback,
        sandbox: this.config.sandbox,
        markApproval: () => {
          run.waitingApproval = true;
        },
        parkChild: (childId) => {
          waiting.add(childId);
        },
      };
      const tools = toolsForPrompt(host, session.systemPrompt);
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
        beforeToolCall: async (context) => this.gate(host, context, claim),
        finishTurn: () => {
          budget.turns += 1;
          if (run.waitingApproval || waiting.size > 0 || budget.turns >= this.config.maxTurns) return { action: "end" };
          return undefined;
        },
        transformContext: async (messages: AgentMessage[]) => {
          if (!this.config.compactRequests) return messages;
          const planned = planContext(messages, {
            maxChars: this.config.compactMaxChars,
            contextWindow: llm.model.contextWindow,
          });
          if (planned.compacted) {
            const at = new Date().toISOString();
            this.db.addTrace({
              taskId: task.id,
              kind: "context",
              name: "compact",
              startedAt: at,
              endedAt: at,
              claim,
              data: {
                beforeChars: planned.beforeChars,
                afterChars: planned.afterChars,
                beforeTokens: planned.beforeTokens,
                afterTokens: planned.afterTokens,
                droppedMessages: planned.droppedMessages,
                shrunkResults: planned.shrunkResults,
              },
            });
          }
          return planned.messages;
        },
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
            claim,
          });
          run.turn += 1;
        }
        if (event.type === "tool_execution_start") {
          const at = new Date().toISOString();
          this.db.addTrace({
            taskId: task.id,
            kind: "tool",
            name: event.toolName,
            startedAt: at,
            data: { phase: "start", toolCallId: event.toolCallId },
            claim,
          });
        }
        if (event.type === "tool_execution_end") {
          const ended = Date.now();
          const goalStepId = attributeParentTool(this.db.getTask(task.id)?.goal ?? null, event.toolName);
          this.db.addTrace({
            taskId: task.id,
            kind: "tool",
            name: event.toolName,
            startedAt: new Date(ended - (event.durationMs ?? 0)).toISOString(),
            endedAt: new Date(ended).toISOString(),
            claim,
            data: {
              phase: "end",
              toolCallId: event.toolCallId,
              isError: event.isError,
              durationMs: event.durationMs ?? null,
              ...(goalStepId ? { goalStepId } : {}),
            },
          });
        }
      });
      const prompt = task.checkpoint?.continuation
        ? task.checkpoint.continuation
        : composeUserMessage(task.prompt, {
            workspace: workspaceRoot,
            now: new Date().toISOString(),
            memories: selectMemories(this.db.listMemories(task.userId), task.prompt).map((memory) => ({
              title: memory.title,
              body: memory.body,
            })),
          });
      const owns = () => this.db.holdsLease(task.id, task.fence, workerId);
      let feedback = "";
      for (let round = 0; round < 2; round += 1) {
        if (round === 0) {
          if (resumeChildren) await agent.continue();
          else await agent.prompt(prompt);
        } else await agent.prompt(feedback);
        if (!owns()) return;
        this.persist(agent, session.id, task.prompt, claim);
        if (abort.signal.aborted) {
          if (owns()) {
            this.cancelFamily(task.id);
            this.db.finishTask(task.id, "cancelled", { error: "cancelled", firstResponseMs: run.firstResponseMs }, claim);
          }
          return;
        }
        if (waiting.size > 0) {
          const parked = this.db.markWaitingChildren(task.id, [...waiting], run.firstResponseMs, claim);
          if (parked) {
            this.db.addTrace({
              taskId: task.id,
              kind: "orchestration",
              name: "waiting_children",
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              data: { childIds: [...waiting] },
              claim,
            });
            this.db.wakeParent(task.id);
            return;
          }
        }
        if (run.waitingApproval) {
          if (this.db.markPaused(task.id, run.firstResponseMs, claim)) {
            this.notify(task, "Onay bekleniyor", "Bir araç kullanıcı onayı olmadan çalışmadı.");
          }
          return;
        }
        if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
        const result = lastAssistantText(agent.state.messages);
        const unmet = goalSuccessBlock(this.db.getTask(task.id)?.goal ?? null);
        if (unmet) {
          this.db.finishTask(task.id, "failed", { error: unmet, resultText: result, firstResponseMs: run.firstResponseMs }, claim);
          return;
        }
        const gap = await this.evidenceGap(task, host, agent.state.messages);
        if (!gap) {
          const finished = this.db.finishTask(task.id, "succeeded", { resultText: result, firstResponseMs: run.firstResponseMs }, claim);
          if (finished && (task.kind === "cron" || task.kind === "heartbeat" || task.kind === "webhook")) {
            this.notify(task, "Görev bitti", result || task.prompt);
          }
          return;
        }
        if (gap.uncertain) {
          this.db.finishTask(task.id, "needs_inspection", { error: gap.missing, resultText: result, firstResponseMs: run.firstResponseMs }, claim);
          return;
        }
        if (!gap.retry || round === 1) {
          this.db.finishTask(task.id, "failed", { error: gap.missing, resultText: result, firstResponseMs: run.firstResponseMs }, claim);
          return;
        }
        feedback = `Evidence is missing. ${gap.missing} Do this once. Do not repeat an action that already succeeded.`;
      }
    } catch (caught) {
      if (!this.db.holdsLease(task.id, task.fence, workerId)) return;
      if (agent) {
        const messages = resumeChildren ? dropTrailingAssistantError(agent.state.messages) : agent.state.messages;
        this.db.setTranscript(task.sessionId, messages, task.prompt.slice(0, 80), claim);
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      if (abort.signal.aborted) {
        this.cancelFamily(task.id);
        this.db.finishTask(task.id, "cancelled", { error: message, firstResponseMs: run.firstResponseMs }, claim);
        return;
      }
      const current = this.db.getTask(task.id);
      if (current && current.attempt + 1 < current.maxAttempts && this.db.requeueTask(task.id, message, claim)) return;
      const failed = this.db.finishTask(task.id, "failed", { error: message, firstResponseMs: run.firstResponseMs }, claim);
      if (failed && (task.kind === "cron" || task.kind === "heartbeat" || task.kind === "webhook")) {
        this.notify(task, "Görev hata verdi", message);
      }
    } finally {
      clearInterval(beat);
      closeJevTask(task.id);
      await closeTaskBrowser(task.id);
      this.aborts.delete(task.id);
    }
  }

  private async evidenceGap(task: Task, host: ToolHost, messages: AgentMessage[]): Promise<{ missing: string; uncertain: boolean; retry: boolean } | null> {
    const contract = contractForPrompt(task.prompt);
    if (!contract) return null;
    const tools = this.db.listTraces(task.id).flatMap((trace) => {
      if (trace.kind !== "tool") return [];
      const data = trace.data as { phase?: string; isError?: boolean };
      if (data.phase !== "end") return [];
      return [{ name: trace.name, isError: data.isError === true }];
    });
    let pageUrl = "";
    let pageTitle = "";
    let pageText = "";
    if (contract.kind.startsWith("browser") && host.vmBrowser) {
      try {
        const page = await host.vmBrowser.act({ op: "read" });
        pageUrl = page.url ?? "";
        pageTitle = page.title ?? "";
        pageText = page.text ?? "";
      } catch (error) {
        pageText = error instanceof Error ? error.message : String(error);
      }
    }
    let fileText = "";
    let fileError = "";
    if (contract.file && host.files) {
      try {
        fileText = (await host.files.read(contract.file)).text;
      } catch (error) {
        fileError = error instanceof Error ? error.message : String(error);
      }
    }
    const outputs = messages.flatMap((message) => {
      const record = message as { role?: string; content?: unknown };
      if (record.role === "assistant" || record.role === "user") return [];
      return [JSON.stringify(record.content ?? "").slice(0, 2000)];
    });
    const children = contract.kind === "subagents" ? this.db.listChildren(task.id).map((child) => ({ status: child.status })) : undefined;
    return missingEvidence(contract, { tools, pageUrl, pageTitle, pageText, fileText, fileError, outputs, children });
  }

  private gate(host: ToolHost, context: BeforeToolCallContext, claim: TaskClaim) {
    if (!this.db.holdsLease(claim.taskId, claim.fence, claim.workerId)) {
      return { block: true, terminate: true, reason: "worker lease is no longer held" };
    }
    const boatMutation = host.desktop && (context.toolCall.name === "browser_click" || context.toolCall.name === "browser_fill" || context.toolCall.name === "browser_select");
    const assessment = boatMutation
      ? { action: "approve" as const, risk: "network" as const, reason: "Changing the Boat page needs user approval." }
      : assess(context.toolCall.name, context.args, host.workspaceRoot);
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
      claim,
    });
    host.markApproval();
    return { block: true, terminate: true, reason: assessment.reason };
  }

  private cancelFamily(taskId: string): void {
    for (const child of this.db.listChildren(taskId)) {
      if (child.status === "succeeded" || child.status === "failed" || child.status === "cancelled") continue;
      this.cancel(child.id);
    }
  }

  private persist(agent: Agent, sessionId: string, prompt: string, claim: TaskClaim): void {
    if (!this.db.setTranscript(sessionId, agent.state.messages, prompt.slice(0, 80), claim)) {
      throw new Error("stale worker lost the transcript fence");
    }
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

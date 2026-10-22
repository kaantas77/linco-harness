import fs from "node:fs";
import path from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { Harness } from "../agent/runtime.js";
import type { LincoConfig } from "../config.js";
import { createDeepSeek } from "../llm/deepseek.js";
import { BARE_SYSTEM_PROMPT, createBareTools } from "./bare-tools.js";
import { continuityHeld, readContinuity, toolInvocations } from "./continuity.js";
import { compareCache, sumCalls, type CallUsage } from "./metrics.js";
import { emptyCache, pendingLiveReport, usageRatio } from "./report.js";
import { liveScenarios, type LiveScenario } from "./scenarios.js";
import { redactSecrets, type BenchReport, type BenchRunner, type ScenarioResult } from "./types.js";

const PROMPT_TIMEOUT_MS = 120_000;

export async function runComparison(config: LincoConfig): Promise<BenchReport> {
  if (!config.apiKey) return pendingLiveReport(config.model);
  const results: ScenarioResult[] = [];
  for (const scenario of liveScenarios) {
    results.push(await safely("linco", scenario, () => runLincoScenario(scenario, config)));
    results.push(await safely("pi", scenario, () => runBareScenario(scenario, config)));
  }
  return {
    createdAt: new Date().toISOString(),
    mode: "live",
    model: config.model,
    liveExecuted: true,
    performanceClaim: "none",
    results,
    notes: [
      "One run per scenario on each runner. The numbers are measurements, not a ranking.",
      "The Pi runner has fs_list, fs_read, fs_write, fs_edit, and code_run. It has no worker, database, memory, or approval gate.",
      "The Linco runner uses the full tool list, the warm worker, and the session transcript.",
      "session-continue runs first so its first call is the coldest prefix this process can get. Later scenarios can still hit a prefix cached by an earlier scenario.",
      "cacheRead is DeepSeek prompt_cache_hit_tokens as reported by Pi. cache miss tokens are Pi's uncached input tokens.",
      "second model call cacheRead is the second assistant response. In a tool loop that is the follow-up after the first tool result, not the second user message.",
      "second user turn cacheRead is the first model call after the second user message. It is n/a when the scenario has one prompt.",
      "A scenario passes only when the files are right and the required tool calls appear in order. Writing the expected file by another path fails the grade.",
      "reasoning preserved is n/a when the model returned no thinking blocks.",
      "A trailing newline is ignored by the file grader.",
    ],
  };
}

async function safely(runner: BenchRunner, scenario: LiveScenario, run: () => Promise<ScenarioResult>): Promise<ScenarioResult> {
  try {
    return await run();
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    return {
      runner,
      scenarioId: scenario.id,
      group: scenario.group,
      ok: false,
      status: "error",
      durationMs: 0,
      firstResponseMs: null,
      usage: sumCalls([]),
      cacheHitRatio: 0,
      calls: [],
      cache: emptyCache(),
      detail: message,
    };
  }
}

async function runLincoScenario(scenario: LiveScenario, config: LincoConfig): Promise<ScenarioResult> {
  const harness = new Harness({
    config: {
      ...config,
      dataDir: path.join(config.dataDir, "linco", scenario.id),
      workerCount: 1,
      maxTurns: 8,
      schedulerIntervalMs: 60_000,
      ...(scenario.reasoning ? { thinkingLevel: "low" as const } : {}),
    },
  });
  harness.start();
  const started = Date.now();
  let firstResponseMs: number | null = null;
  try {
    const user = harness.createUser(scenario.id);
    scenario.prepare?.(user.workspacePath);
    const session = harness.createSession(user.id);
    const statuses: string[] = [];
    let before: ReturnType<typeof readContinuity> | null = null;
    for (const prompt of scenario.prompts) {
      let task = await harness.submit(session.id, prompt, { kind: "bench", waitMs: PROMPT_TIMEOUT_MS, maxAttempts: 1 });
      if (task.status === "queued" || task.status === "running") {
        harness.cancel(task.id);
        task = await harness.waitForTask(task.id, 5_000);
      }
      statuses.push(task.status);
      if (firstResponseMs === null) firstResponseMs = task.firstResponseMs;
      if (!before) before = readContinuity(harness.db.getTranscript(session.id));
    }
    const messages = harness.db.getTranscript(session.id);
    const calls = harness.db.listSessionTasks(session.id).flatMap((task, userTurn) =>
      harness.db.listUsage(task.id).map((event) => ({ ...toCall(event), userTurn })),
    );
    return finishResult({
      runner: "linco",
      scenario,
      workspace: user.workspacePath,
      statuses,
      durationMs: Date.now() - started,
      firstResponseMs,
      calls,
      messages,
      installedPrompt: session.systemPrompt,
      before,
      after: readContinuity(messages),
    });
  } finally {
    await harness.stop();
  }
}

async function runBareScenario(scenario: LiveScenario, config: LincoConfig): Promise<ScenarioResult> {
  const workspace = path.join(config.dataDir, "pi", scenario.id, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  scenario.prepare?.(workspace);
  const { model, streamFn } = createDeepSeek(config.model);
  const abort = new AbortController();
  const tools = createBareTools(workspace, abort.signal);
  const calls: CallUsage[] = [];
  const cursor = { userTurn: 0 };
  let firstResponseMs: number | null = null;
  const started = Date.now();
  const agent = new Agent({
    initialState: {
      systemPrompt: BARE_SYSTEM_PROMPT,
      model,
      tools,
      ...(scenario.reasoning ? { thinkingLevel: "low" as const } : {}),
    },
    streamFn,
    getApiKey: async () => config.apiKey,
    toolExecution: "parallel",
    sessionId: `pi-${scenario.id}`,
  });
  agent.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "assistant" && firstResponseMs === null) {
      firstResponseMs = Date.now() - started;
    }
    if (event.type === "message_end" && event.message.role === "assistant" && "usage" in event.message) {
      calls.push({ ...fromUsage(event.message.usage), userTurn: cursor.userTurn });
    }
  });
  const statuses: string[] = [];
  let before: ReturnType<typeof readContinuity> | null = null;
  for (const prompt of scenario.prompts) {
    try {
      await runPrompt(agent, prompt);
      statuses.push(agent.state.errorMessage ? "failed" : "succeeded");
    } catch (error) {
      statuses.push("failed");
      if (!(error instanceof Error) || error.message !== "timed out") throw error;
    }
    if (!before) before = readContinuity(agent.state.messages);
    cursor.userTurn += 1;
  }
  return finishResult({
    runner: "pi",
    scenario,
    workspace,
    statuses,
    durationMs: Date.now() - started,
    firstResponseMs,
    calls,
    messages: agent.state.messages,
    installedPrompt: BARE_SYSTEM_PROMPT,
    before,
    after: readContinuity(agent.state.messages),
  });
}

function runPrompt(agent: Agent, prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      agent.abort();
      reject(new Error("timed out"));
    }, PROMPT_TIMEOUT_MS);
    agent.prompt(prompt).then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function finishResult(input: {
  runner: BenchRunner;
  scenario: LiveScenario;
  workspace: string;
  statuses: string[];
  durationMs: number;
  firstResponseMs: number | null;
  calls: CallUsage[];
  messages: AgentMessage[];
  installedPrompt: string;
  before: ReturnType<typeof readContinuity> | null;
  after: ReturnType<typeof readContinuity>;
}): ScenarioResult {
  const grade = input.scenario.grade({ workspace: input.workspace, tools: toolInvocations(input.messages) });
  const failed = input.statuses.some((status) => status !== "succeeded");
  const usage = sumCalls(input.calls);
  const held = input.before ? continuityHeld(input.before, input.after) : null;
  const cache = compareCache(input.calls);
  return {
    runner: input.runner,
    scenarioId: input.scenario.id,
    group: input.scenario.group,
    ok: !failed && grade === undefined,
    status: input.statuses.at(-1) ?? "missing",
    durationMs: input.durationMs,
    firstResponseMs: input.firstResponseMs,
    usage,
    cacheHitRatio: usageRatio(usage),
    calls: input.calls,
    cache: {
      ...cache,
      systemPromptStable: input.after.systemPrompt === input.installedPrompt && (held ? held.systemPromptStable : input.after.systemPrompt.length > 0),
      toolOrderStable: input.after.toolNames.length > 0 && (held ? held.toolOrderStable : true),
      reasoningPreserved: held ? held.reasoningPreserved : input.after.thinking.length === 0 ? null : true,
    },
    detail: redactSecrets(grade ?? (failed ? input.statuses.join(",") : "ok")),
  };
}

function toCall(event: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }): Omit<CallUsage, "userTurn"> {
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    costUsd: event.costUsd,
  };
}

function fromUsage(usage: Usage): Omit<CallUsage, "userTurn"> {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    costUsd: usage.cost.total,
  };
}

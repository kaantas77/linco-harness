import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "../agent/runtime.js";
import type { LincoConfig } from "../config.js";
import { compareCache, sumCalls, type CacheComparison } from "./metrics.js";
import { buildLongTranscript } from "./context.js";
import { redactSecrets } from "./types.js";
import type { Task } from "../types.js";

export interface ContextSlot {
  repeat: number;
  scenarioId: string;
  mode: "on" | "off";
}

export interface ContextLiveRun {
  repeat: number;
  scenarioId: string;
  mode: "on" | "off";
  ok: boolean;
  status: string;
  durationMs: number;
  firstResponseMs: number | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens: number;
  costUsd: number;
  cache: CacheComparison;
  compacted: boolean;
  charsRemoved: number;
  tokensRemoved: number;
  lostCritical: number;
  badActions: number;
  detail: string;
}

export interface ContextLiveSummary {
  scenarioId: string;
  mode: "on" | "off";
  runs: number;
  successRate: number;
  medianDurationMs: number | null;
  durationSpread: [number, number] | null;
  medianFirstResponseMs: number | null;
  medianCalls: number | null;
  medianInputTokens: number | null;
  medianOutputTokens: number | null;
  medianCostUsd: number | null;
  medianCacheHitRatio: number | null;
  compactionRuns: number;
  medianCharsRemoved: number | null;
  lostCritical: number;
  badActions: number;
}

export interface ContextLiveReport {
  createdAt: string;
  mode: "live";
  model: string;
  liveExecuted: boolean;
  performanceClaim: "none";
  repeats: number;
  runs: ContextLiveRun[];
  summary: ContextLiveSummary[];
  notes: string[];
}

const WAIT_MS = 90_000;

export function balancedSchedule(ids: string[], repeats: number): ContextSlot[] {
  const slots: ContextSlot[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const order = repeat % 2 === 0 ? ids : [...ids].reverse();
    const modes: Array<"on" | "off"> = repeat % 2 === 0 ? ["on", "off"] : ["off", "on"];
    for (const scenarioId of order) {
      for (const mode of modes) slots.push({ repeat, scenarioId, mode });
    }
  }
  return slots;
}

export async function runContextLive(config: LincoConfig, repeats = 5): Promise<ContextLiveReport> {
  const ids = SCENARIOS.map((scenario) => scenario.id);
  if (!config.apiKey) {
    return {
      createdAt: new Date().toISOString(),
      mode: "live",
      model: config.model,
      liveExecuted: false,
      performanceClaim: "none",
      repeats,
      runs: [],
      summary: [],
      notes: ["No DeepSeek call was made. DEEPSEEK_API_KEY was unset."],
    };
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-context-live-"));
  const harness = new Harness({
    config: { ...config, dataDir: root, workerCount: 2, maxTurns: 8, schedulerIntervalMs: 60_000 },
  });
  harness.start();
  const runs: ContextLiveRun[] = [];
  let aborted = "";
  try {
    for (const slot of balancedSchedule(ids, repeats)) {
      const scenario = SCENARIOS.find((item) => item.id === slot.scenarioId);
      if (!scenario) continue;
      const run = await runSlot(harness, scenario, slot);
      runs.push(run);
      if (authFailed(run.detail)) {
        aborted = run.detail;
        break;
      }
    }
  } finally {
    await harness.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
  const executed = runs.length > 0 && !aborted;
  return {
    createdAt: new Date().toISOString(),
    mode: "live",
    model: config.model,
    liveExecuted: executed,
    performanceClaim: "none",
    repeats,
    runs,
    summary: summarize(runs),
    notes: [
      aborted ? `Live run stopped: ${aborted}` : "Each run is a fresh session. Its first model call is a cold prefix. secondUserTurn is the warm turn inside that session.",
      "secondCallCacheRead is the second model call and is often the tool follow-up of the first user message.",
      "On and off use the same model, tool list, prompts, and thinking level. On compacts only after 180000 serialized characters.",
      "Medians are within this sample. One sample is not a ranking.",
      "Dollar amounts and token counts come from the provider usage on these calls.",
    ],
  };
}

export function renderContextLiveMarkdown(report: ContextLiveReport): string {
  const lines = [
    "# Linco context live comparison",
    "",
    `Model: ${report.model}. Live executed: ${report.liveExecuted}. Repeats: ${report.repeats}. Performance claim: ${report.performanceClaim}.`,
    "",
    "| scenario | mode | runs | success | median ms | median first ms | median calls | median in | median out | median cache hit | median USD | compact runs | median chars removed | lost | bad actions |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of report.summary) {
    lines.push(
      `| ${row.scenarioId} | ${row.mode} | ${row.runs} | ${row.successRate.toFixed(2)} | ${fmt(row.medianDurationMs)} | ${fmt(row.medianFirstResponseMs)} | ${fmt(row.medianCalls)} | ${fmt(row.medianInputTokens)} | ${fmt(row.medianOutputTokens)} | ${row.medianCacheHitRatio === null ? "" : row.medianCacheHitRatio.toFixed(3)} | ${row.medianCostUsd === null ? "" : row.medianCostUsd.toFixed(6)} | ${row.compactionRuns} | ${fmt(row.medianCharsRemoved)} | ${row.lostCritical} | ${row.badActions} |`,
    );
  }
  lines.push("", "## Notes", "");
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push("");
  return lines.join("\n");
}

const SCENARIOS: Array<{
  id: string;
  prompts: string[];
  long: boolean;
  grade: (harness: Harness, tasks: Task[], workspace: string) => string | undefined;
}> = [
  {
    id: "file-op",
    long: false,
    prompts: ["Use the fs_write tool to create note.txt. The file content must be exactly pear. Do not call any other tool. After the tool succeeds, stop."],
    grade: (_harness, _tasks, workspace) => (readFile(workspace, "note.txt") === "pear" ? undefined : "note.txt was not exactly pear"),
  },
  {
    id: "multi-tool",
    long: false,
    prompts: [
      "Use fs_write to create note.txt with content exactly pear. Then use fs_read on note.txt. Do not call any other tool. After the read succeeds, stop.",
    ],
    grade: (harness, tasks, workspace) => {
      if (readFile(workspace, "note.txt") !== "pear") return "note.txt was not exactly pear";
      const names = tasks.flatMap((task) => harness.db.listTraces(task.id).filter((trace) => trace.kind === "tool").map((trace) => trace.name));
      if (!names.includes("fs_write") || !names.includes("fs_read")) return "write and read were not both traced";
      return undefined;
    },
  },
  {
    id: "session-continue",
    long: false,
    prompts: [
      "Use the fs_write tool to create note.txt. The file content must be exactly pear. Do not call any other tool. After the tool succeeds, stop.",
      "Use the fs_read tool on note.txt. Do not modify the file. After the tool succeeds, stop.",
    ],
    grade: (harness, tasks, workspace) => {
      if (readFile(workspace, "note.txt") !== "pear") return "note.txt was not exactly pear";
      const second = tasks[1];
      if (!second) return "second user turn did not run";
      const read = harness.db.listTraces(second.id).some((trace) => trace.kind === "tool" && trace.name === "fs_read");
      return read ? undefined : "second turn did not read note.txt";
    },
  },
  {
    id: "two-subagents",
    long: false,
    prompts: [
      "Call task_spawn twice in one response. First child prompt: Use the fs_write tool to create alpha.txt. The file content must be exactly alpha. Do not call any other tool. After the tool succeeds, stop. Second child prompt: Use the fs_write tool to create beta.txt. The file content must be exactly beta. Do not call any other tool. After the tool succeeds, stop. Then call task_wait for both ids. Then stop.",
    ],
    grade: (harness, tasks, workspace) => {
      const parent = tasks[0];
      if (!parent) return "parent did not run";
      const children = harness.db.listChildren(parent.id);
      if (children.length < 2) return "two children were not spawned";
      if (children.some((child) => child.status !== "succeeded")) return "a child did not succeed";
      if (readFile(workspace, "alpha.txt") !== "alpha" || readFile(workspace, "beta.txt") !== "beta") return "child files were not exact";
      return undefined;
    },
  },
  {
    id: "goal-evidence",
    long: false,
    prompts: [
      'Call goal_set with goal "write pear", replanBudget 1, and one step id "write", title "Write pear", expectedOutput "pear", dependsOn [], and one required criterion id "file", description "file has pear", check {"kind":"file_contains","path":"note.txt","text":"pear"}. Then fs_write note.txt with content exactly pear. Then goal_evidence for stepId write. Then stop.',
    ],
    grade: (harness, tasks, workspace) => {
      const task = tasks[0];
      if (!task) return "task did not run";
      const goal = harness.db.getTask(task.id)?.goal;
      const criterion = goal?.steps.find((step) => step.id === "write")?.criteria[0];
      if (readFile(workspace, "note.txt") !== "pear") return "note.txt was not exactly pear";
      if (task.status !== "succeeded") return task.error ?? task.status;
      if (criterion?.status !== "verified") return "file criterion was not verified";
      return undefined;
    },
  },
  {
    id: "long-transcript",
    long: true,
    prompts: ["Use the fs_write tool to create note.txt. The file content must be exactly pear. Do not call any other tool. After the tool succeeds, stop."],
    grade: (_harness, _tasks, workspace) => (readFile(workspace, "note.txt") === "pear" ? undefined : "note.txt was not exactly pear"),
  },
];

async function runSlot(
  harness: Harness,
  scenario: (typeof SCENARIOS)[number],
  slot: ContextSlot,
): Promise<ContextLiveRun> {
  harness.config.compactRequests = slot.mode === "on";
  const started = Date.now();
  const user = harness.createUser(`${scenario.id}-${slot.mode}-${slot.repeat}`);
  const session = harness.createSession(user.id);
  if (scenario.long) harness.db.setTranscript(session.id, buildLongTranscript(session.systemPrompt, 190_000), "seed");
  const tasks: Task[] = [];
  let detail = "";
  try {
    for (const prompt of scenario.prompts) {
      let task = await harness.submit(session.id, prompt, { kind: "bench", waitMs: WAIT_MS, maxAttempts: 1 });
      if (task.status === "queued" || task.status === "running" || task.status === "waiting_children" || task.status === "waiting_approval") {
        harness.cancel(task.id);
        task = harness.db.getTask(task.id) ?? task;
      }
      tasks.push(task);
      if (task.status !== "succeeded") {
        detail = redactSecrets(task.error ?? task.status);
        break;
      }
    }
    if (!detail) detail = redactSecrets(scenario.grade(harness, tasks, user.workspacePath) ?? "");
  } catch (caught) {
    detail = redactSecrets(caught instanceof Error ? caught.message : String(caught));
  }
  const parent = tasks[0];
  const calls = tasks.flatMap((task, userTurn) =>
    harness.db.listUsage(task.id).map((event) => ({
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      costUsd: event.costUsd,
      userTurn,
    })),
  );
  const total = sumCalls(calls);
  const traces = tasks.flatMap((task) => harness.db.listTraces(task.id));
  const compacts = traces.filter((trace) => trace.kind === "context" && trace.name === "compact");
  let charsRemoved = 0;
  let tokensRemoved = 0;
  for (const trace of compacts) {
    const data = trace.data && typeof trace.data === "object" ? (trace.data as Record<string, number>) : {};
    charsRemoved += Math.max(0, (data.beforeChars ?? 0) - (data.afterChars ?? 0));
    tokensRemoved += Math.max(0, (data.beforeTokens ?? 0) - (data.afterTokens ?? 0));
  }
  const transcript = JSON.stringify(harness.db.getTranscript(session.id));
  const recordKept = !scenario.long || (transcript.includes("MIDDLE-ONLY") && transcript.includes("leave existing files alone"));
  const badActions = traces.filter((trace) => trace.kind === "tool" && traceIsError(trace.data)).length;
  const ok = detail === "" && tasks.every((task) => task.status === "succeeded") && recordKept;
  return {
    repeat: slot.repeat,
    scenarioId: scenario.id,
    mode: slot.mode,
    ok,
    status: tasks.at(-1)?.status ?? "error",
    durationMs: Date.now() - started,
    firstResponseMs: tasks[0]?.firstResponseMs ?? null,
    calls: calls.length,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    cacheReadTokens: total.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens,
    cacheMissTokens: total.inputTokens,
    costUsd: total.costUsd,
    cache: compareCache(calls),
    compacted: compacts.length > 0,
    charsRemoved,
    tokensRemoved,
    lostCritical: ok ? 0 : 1,
    badActions,
    detail: ok ? "passed" : detail || "record lost critical text",
  };
}

function summarize(runs: ContextLiveRun[]): ContextLiveSummary[] {
  const keys = new Map<string, ContextLiveRun[]>();
  for (const run of runs) {
    const key = `${run.scenarioId}:${run.mode}`;
    keys.set(key, [...(keys.get(key) ?? []), run]);
  }
  return [...keys.values()].map((group) => {
    const sample = group[0]!;
    const successes = group.filter((run) => run.ok).length;
    return {
      scenarioId: sample.scenarioId,
      mode: sample.mode,
      runs: group.length,
      successRate: successes / group.length,
      medianDurationMs: median(group.map((run) => run.durationMs)),
      durationSpread: spread(group.map((run) => run.durationMs)),
      medianFirstResponseMs: median(group.map((run) => run.firstResponseMs).filter((value): value is number => value !== null)),
      medianCalls: median(group.map((run) => run.calls)),
      medianInputTokens: median(group.map((run) => run.inputTokens)),
      medianOutputTokens: median(group.map((run) => run.outputTokens)),
      medianCostUsd: median(group.map((run) => run.costUsd)),
      medianCacheHitRatio: median(group.map((run) => hitRatio(run))),
      compactionRuns: group.filter((run) => run.compacted).length,
      medianCharsRemoved: median(group.map((run) => run.charsRemoved)),
      lostCritical: group.reduce((total, run) => total + run.lostCritical, 0),
      badActions: group.reduce((total, run) => total + run.badActions, 0),
    };
  });
}

function fmt(value: number | null): string {
  return value === null ? "" : String(Math.round(value * 1000) / 1000);
}

function hitRatio(run: ContextLiveRun): number {
  const denominator = run.inputTokens + run.cacheReadTokens + run.cacheWriteTokens;
  if (denominator <= 0) return 0;
  return run.cacheReadTokens / denominator;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const right = sorted[mid];
  if (right === undefined) return null;
  if (sorted.length % 2 === 1) return right;
  const left = sorted[mid - 1];
  return left === undefined ? right : (left + right) / 2;
}

function spread(values: number[]): [number, number] | null {
  if (values.length === 0) return null;
  return [Math.min(...values), Math.max(...values)];
}

function readFile(workspace: string, relative: string): string {
  const file = path.join(workspace, relative);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
}

function traceIsError(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && "isError" in data && (data as { isError?: boolean }).isError);
}

function authFailed(detail: string): boolean {
  return /401|403|invalid api key|authentication/i.test(detail);
}

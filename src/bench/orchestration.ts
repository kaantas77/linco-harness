import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Harness } from "../agent/runtime.js";
import { loadConfig } from "../config.js";
import { SCRIPT_MODEL, scriptedReply } from "../llm/scripted.js";
import type { Task } from "../types.js";

export interface OrchestrationScenario {
  id: "parallel" | "sequential" | "failure" | "cancel" | "restart";
  ok: boolean;
  durationMs: number;
  workerCount: number;
  parentStatus: string;
  overlapped: boolean | null;
  parentWaitMs: number | null;
  childMs: number[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
  counts: { succeeded: number; failed: number; cancelled: number };
  detail: string;
}

export interface OrchestrationReport {
  createdAt: string;
  mode: "offline";
  performanceClaim: "none";
  scenarios: OrchestrationScenario[];
  notes: string[];
}

const SLEEP_MS = 350;

export async function runOrchestrationBench(skillsDir: string): Promise<OrchestrationReport> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-orch-"));
  try {
    const parallel = await runPair(path.join(root, "parallel"), skillsDir, 2, true);
    const sequential = await runPair(path.join(root, "sequential"), skillsDir, 1, false);
    const failure = await runFailure(path.join(root, "failure"), skillsDir);
    const cancel = await runCancel(path.join(root, "cancel"), skillsDir);
    const restart = await runRestart(path.join(root, "restart"), skillsDir);
    return {
      createdAt: new Date().toISOString(),
      mode: "offline",
      performanceClaim: "none",
      scenarios: [parallel, sequential, failure, cancel, restart],
      notes: [
        "Scripted model. These rows are not DeepSeek latency, tokens, cache, or cost.",
        "Parallel and sequential rows sleep 350 ms inside each child. Wall clock includes process and SQLite overhead.",
        "Children share the parent workspace. This phase does not give them separate directories.",
        "A crashed running task is still not reaped. Wake is a single conditional update from waiting_children.",
      ],
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function renderOrchestrationMarkdown(report: OrchestrationReport): string {
  const lines = [
    "# Linco orchestration",
    "",
    `Created: ${report.createdAt}`,
    "Mode: offline",
    "Performance claim: none. Scripted sleeps are not a DeepSeek ranking.",
    "",
    "| Scenario | OK | Workers | Parent | Duration ms | Parent wait ms | Overlap | Succeeded | Failed | Cancelled |",
    "| --- | --- | ---: | --- | ---: | ---: | --- | ---: | ---: | ---: |",
  ];
  for (const row of report.scenarios) {
    lines.push(
      `| ${row.id} | ${row.ok ? "yes" : "no"} | ${row.workerCount} | ${row.parentStatus} | ${row.durationMs} | ${row.parentWaitMs ?? ""} | ${row.overlapped === null ? "" : row.overlapped ? "yes" : "no"} | ${row.counts.succeeded} | ${row.counts.failed} | ${row.counts.cancelled} |`,
    );
  }
  lines.push("", "## Notes", "");
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push("");
  for (const row of report.scenarios) {
    if (!row.ok) lines.push(`- ${row.id}: ${row.detail}`);
  }
  return lines.join("\n");
}

async function runPair(dataDir: string, skillsDir: string, workerCount: number, expectOverlap: boolean): Promise<OrchestrationScenario> {
  const started = Date.now();
  const harness = harnessFor(dataDir, skillsDir, workerCount, pairStream);
  harness.start();
  try {
    const user = harness.createUser("Ada");
    const session = harness.createSession(user.id);
    const task = await harness.submit(session.id, "Fan out two notes.", { waitMs: 8_000 });
    const children = harness.db.listChildren(task.id);
    const overlap = readOverlap(user.workspacePath);
    const overlapped = overlappedRuns(overlap);
    const users = harness.db.getTranscript(session.id).filter((message) => message.role === "user").length;
    const detail = gradePair(task, children, overlapped, expectOverlap, users);
    return scenario(workerCount === 1 ? "sequential" : "parallel", {
      ok: detail === undefined,
      durationMs: Date.now() - started,
      workerCount,
      parentStatus: task.status,
      overlapped,
      parentWaitMs: waitMs(harness, task.id),
      childMs: children.map(taskMs),
      tokens: tokensFor(harness, [task, ...children]),
      counts: countsOf([task, ...children]),
      detail: detail ?? "parent resumed once and both children finished",
    });
  } finally {
    await harness.stop();
  }
}

function gradePair(task: Task, children: Task[], overlapped: boolean, expectOverlap: boolean, users: number): string | undefined {
  if (task.status !== "succeeded") return `parent ${task.status}`;
  if (children.length !== 2) return `children ${children.length}`;
  if (children.some((child) => child.status !== "succeeded")) {
    return children.map((child) => `${child.status}:${child.error ?? child.resultText ?? ""}`).join(" | ");
  }
  if (users !== 1) return `user messages ${users}`;
  if (expectOverlap !== overlapped) return expectOverlap ? "children did not overlap" : "children overlapped on one worker";
  if (!String(task.resultText).includes("combined report")) return "parent did not continue from the child reports";
  return undefined;
}

async function runFailure(dataDir: string, skillsDir: string): Promise<OrchestrationScenario> {
  const started = Date.now();
  const harness = harnessFor(dataDir, skillsDir, 2, failureStream);
  harness.start();
  try {
    const user = harness.createUser("Ada");
    const session = harness.createSession(user.id);
    const task = await harness.submit(session.id, "Fan out a success and a failure.", { waitMs: 8_000 });
    const children = harness.db.listChildren(task.id);
    const reports = toolResultTexts(harness.db.getTranscript(session.id));
    const sawBoth = reports.some((report) => report.includes('"status":"succeeded"')) && reports.some((report) => report.includes('"status":"failed"'));
    const users = harness.db.getTranscript(session.id).filter((message) => message.role === "user").length;
    let detail: string | undefined;
    if (task.status !== "succeeded") detail = `parent ${task.status}`;
    else if (!sawBoth) detail = "parent transcript missed a child outcome";
    else if (users !== 1) detail = `user messages ${users}`;
    else if (children.length !== 2) detail = `children ${children.length}`;
    return row("failure", harness, task, children, detail, Date.now() - started, null);
  } finally {
    await harness.stop();
  }
}

async function runCancel(dataDir: string, skillsDir: string): Promise<OrchestrationScenario> {
  const started = Date.now();
  const harness = harnessFor(dataDir, skillsDir, 2, pairStream);
  harness.start();
  try {
    const user = harness.createUser("Ada");
    const session = harness.createSession(user.id);
    const task = await harness.submit(session.id, "Fan out two notes.");
    const parked = await pollStatus(harness, task.id, "waiting_children", 4_000);
    harness.cancel(task.id);
    const done = await harness.waitForTask(task.id, 4_000);
    const children = await waitTerminalChildren(harness, task.id, 4_000);
    let detail: string | undefined;
    if (!parked) detail = "parent did not release the worker";
    else if (done.status !== "cancelled") detail = `parent ${done.status}`;
    else if (children.length !== 2 || children.some((child) => child.status !== "cancelled" && child.status !== "succeeded")) {
      detail = `children ${children.map((child) => child.status).join(",")}`;
    }
    return row("cancel", harness, done, children, detail, Date.now() - started, null);
  } finally {
    await harness.stop();
  }
}

async function runRestart(dataDir: string, skillsDir: string): Promise<OrchestrationScenario> {
  const started = Date.now();
  let calls = 0;
  const reply = scriptedReply(() => ({ text: "resumed once" }));
  const stream: StreamFn = (model, context, options) => {
    calls += 1;
    return reply(model, context, options);
  };
  const harness = harnessFor(dataDir, skillsDir, 2, stream);
  const user = harness.createUser("Ada");
  const session = harness.createSession(user.id);
  const childSession = harness.createSession(user.id);
  const parent = harness.db.enqueueTask({ sessionId: session.id, userId: user.id, prompt: "Resume the saved turn.", kind: "chat" });
  const child = harness.db.enqueueTask({
    sessionId: childSession.id,
    userId: user.id,
    prompt: "already done",
    kind: "child",
    parentId: parent.id,
  });
  const claimed = harness.db.claimTask("setup");
  if (!claimed || claimed.id !== parent.id) throw new Error("parent was not claimed");
  harness.db.finishTask(child.id, "succeeded", { resultText: "alpha" });
  harness.db.setTranscript(session.id, [
    { role: "user", content: "Resume the saved turn.", timestamp: Date.now() },
    {
      role: "toolResult",
      toolCallId: "call_wait",
      toolName: "task_wait",
      content: [{ type: "text", text: `LINCO_WAIT ${child.id}` }],
      isError: false,
      timestamp: Date.now(),
    },
  ]);
  const parked = harness.db.markWaitingChildren(parent.id, [child.id]);
  const firstWake = harness.db.wakeParent(parent.id);
  const secondWake = harness.db.wakeParent(parent.id);
  const reclaimed = harness.db.claimTask("setup_again");
  if (!reclaimed || reclaimed.id !== parent.id) throw new Error("parent was not reclaimed");
  const reparked = harness.db.markWaitingChildren(parent.id, [child.id]);
  harness.start();
  try {
    const done = await harness.waitForTask(parent.id, 4_000);
    const stored = harness.db.getTranscript(session.id);
    const users = stored.filter((message) => message.role === "user").length;
    const restored = toolResultTexts(stored).some((report) => report.includes('"status":"succeeded"') && report.includes("alpha"));
    let detail: string | undefined;
    if (!parked || !reparked || !firstWake || secondWake) detail = "wake was not one-shot";
    else if (done.status !== "succeeded") detail = `parent ${done.status}`;
    else if (calls !== 1) detail = `model calls ${calls}`;
    else if (users !== 1) detail = `user messages ${users}`;
    else if (!restored) detail = "child report was not restored";
    return row("restart", harness, done, harness.db.listChildren(parent.id), detail, Date.now() - started, null);
  } finally {
    await harness.stop();
  }
}

function harnessFor(dataDir: string, skillsDir: string, workerCount: number, streamFn: StreamFn): Harness {
  return new Harness({
    config: loadConfig({ dataDir, skillsDir, workerCount, schedulerIntervalMs: 60_000, port: 0 }),
    model: SCRIPT_MODEL,
    streamFn,
  });
}

const pairStream = scriptedReply((messages) => {
  const latest = JSON.stringify([...messages].reverse().find((message) => message.role === "user") ?? {});
  if (latest.includes("CHILD_SLEEP")) {
    const name = latest.includes("alpha") ? "alpha" : "beta";
    if (messages.at(-1)?.role === "toolResult") return { text: `child-${name}` };
    return { calls: [{ name: "shell_exec", arguments: { command: sleepCommand(name) } }] };
  }
  if (!assistantCalled(messages, "task_spawn")) {
    return {
      calls: [
        { name: "task_spawn", arguments: { prompt: "CHILD_SLEEP alpha" } },
        { name: "task_spawn", arguments: { prompt: "CHILD_SLEEP beta" } },
      ],
    };
  }
  if (!assistantCalled(messages, "task_wait")) {
    return { calls: queuedIds(messages).map((taskId) => ({ name: "task_wait", arguments: { taskId } })) };
  }
  return { text: "combined report" };
});

const failureStream = scriptedReply((messages) => {
  const latest = JSON.stringify([...messages].reverse().find((message) => message.role === "user") ?? {});
  if (latest.includes("CHILD_FAIL")) throw new Error("child failed");
  if (latest.includes("CHILD_OK")) return { text: "ok-child" };
  if (!assistantCalled(messages, "task_spawn")) {
    return {
      calls: [
        { name: "task_spawn", arguments: { prompt: "CHILD_OK write the note" } },
        { name: "task_spawn", arguments: { prompt: "CHILD_FAIL stop" } },
      ],
    };
  }
  if (!assistantCalled(messages, "task_wait")) {
    return { calls: queuedIds(messages).map((taskId) => ({ name: "task_wait", arguments: { taskId } })) };
  }
  return { text: "saw both outcomes" };
});

function toolResultTexts(messages: { role: string }[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    texts.push(content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join(""));
  }
  return texts;
}

async function waitTerminalChildren(harness: Harness, parentId: string, timeoutMs: number): Promise<Task[]> {
  const started = Date.now();
  for (;;) {
    const children = harness.db.listChildren(parentId);
    const open = children.some((child) => child.status === "queued" || child.status === "running" || child.status === "waiting_children");
    if (!open || Date.now() - started > timeoutMs) return children;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function assistantCalled(messages: { role: string }[], name: string): boolean {
  return messages.some((message) => {
    if (message.role !== "assistant") return false;
    const content = (message as { content?: unknown }).content;
    return (
      Array.isArray(content) &&
      content.some((part) => {
        if (!part || typeof part !== "object") return false;
        const block = part as { type?: string; name?: string };
        return block.type === "toolCall" && block.name === name;
      })
    );
  });
}

function queuedIds(messages: { role: string }[]): string[] {
  const blob = JSON.stringify(messages.filter((message) => message.role === "toolResult"));
  return [...blob.matchAll(/queued (task_[0-9a-f-]+)/g)].map((match) => match[1]).filter((id): id is string => Boolean(id));
}

function sleepCommand(name: string): string {
  return `node -e "const fs=require('fs'); fs.appendFileSync('overlap.txt', Date.now()+' start ${name}\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${SLEEP_MS}); fs.appendFileSync('overlap.txt', Date.now()+' end ${name}\\n');"`;
}

function readOverlap(workspace: string): string {
  const file = path.join(workspace, "overlap.txt");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function overlappedRuns(text: string): boolean {
  const events = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [stamp, kind] = line.split(" ");
      return { stamp: Number(stamp), kind };
    });
  const starts = events.filter((event) => event.kind === "start").map((event) => event.stamp).sort((left, right) => left - right);
  const ends = events.filter((event) => event.kind === "end").map((event) => event.stamp);
  const secondStart = starts[1];
  const firstEnd = ends.length > 0 ? Math.min(...ends) : 0;
  return secondStart !== undefined && secondStart < firstEnd;
}

function taskMs(task: Task): number {
  if (!task.startedAt || !task.finishedAt) return 0;
  return Date.parse(task.finishedAt) - Date.parse(task.startedAt);
}

function waitMs(harness: Harness, taskId: string): number | null {
  const traces = harness.db.listTraces(taskId).filter((trace) => trace.kind === "orchestration");
  const parked = traces.find((trace) => trace.name === "waiting_children");
  const resumed = traces.find((trace) => trace.name === "resume");
  if (!parked || !resumed) return null;
  return Date.parse(resumed.startedAt) - Date.parse(parked.startedAt);
}

function tokensFor(harness: Harness, tasks: Task[]): OrchestrationScenario["tokens"] {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  for (const task of tasks) {
    const usage = harness.db.usageSummary(task.id);
    totals.input += usage.inputTokens;
    totals.output += usage.outputTokens;
    totals.cacheRead += usage.cacheReadTokens;
    totals.cacheWrite += usage.cacheWriteTokens;
    totals.costUsd += usage.costUsd;
  }
  return totals;
}

function countsOf(tasks: Task[]): OrchestrationScenario["counts"] {
  return {
    succeeded: tasks.filter((task) => task.status === "succeeded").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
  };
}

function row(
  id: OrchestrationScenario["id"],
  harness: Harness,
  task: Task,
  children: Task[],
  detail: string | undefined,
  durationMs: number,
  overlapped: boolean | null,
): OrchestrationScenario {
  return {
    id,
    ok: detail === undefined,
    durationMs,
    workerCount: harness.config.workerCount,
    parentStatus: task.status,
    overlapped,
    parentWaitMs: waitMs(harness, task.id),
    childMs: children.map(taskMs),
    tokens: tokensFor(harness, [task, ...children]),
    counts: countsOf([task, ...children]),
    detail: detail ?? "passed",
  };
}

function scenario(id: OrchestrationScenario["id"], rowValue: Omit<OrchestrationScenario, "id">): OrchestrationScenario {
  return { id, ...rowValue };
}

async function pollStatus(harness: Harness, taskId: string, status: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = harness.db.getTask(taskId);
    if (task?.status === status && task.workerId === null) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

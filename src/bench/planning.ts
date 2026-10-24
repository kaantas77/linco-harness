import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Harness } from "../agent/runtime.js";
import { loadConfig } from "../config.js";
import { SCRIPT_MODEL, scriptedReply, zeroUsage, type ScriptStep } from "../llm/scripted.js";
import type { GoalPlan, Task } from "../types.js";

export interface PlanningScenario {
  id: string;
  ok: boolean;
  mode: "on" | "off";
  durationMs: number;
  status: string;
  turns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
  detail: string;
}

export interface PlanningReport {
  createdAt: string;
  mode: "offline";
  performanceClaim: "none";
  scenarios: PlanningScenario[];
  notes: string[];
}

const USAGE = zeroUsage({ input: 8, output: 2 });
const SLEEP_MS = 350;

export async function runPlanningBench(skillsDir: string): Promise<PlanningReport> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-plan-"));
  try {
    const scenarios = [
      await runDependent(path.join(root, "dependent"), skillsDir),
      await runParallel(path.join(root, "parallel"), skillsDir),
      await runMissing(path.join(root, "missing"), skillsDir),
      await runReplan(path.join(root, "replan"), skillsDir),
      await runPreserve(path.join(root, "preserve"), skillsDir),
      await runChecklist(path.join(root, "checklist"), skillsDir),
      await runCompare(path.join(root, "note-off"), skillsDir, "compare-note", "off"),
      await runCompare(path.join(root, "note-on"), skillsDir, "compare-note", "on"),
      await runClaim(path.join(root, "claim-off"), skillsDir, "off"),
      await runClaim(path.join(root, "claim-on"), skillsDir, "on"),
    ];
    return {
      createdAt: new Date().toISOString(),
      mode: "offline",
      performanceClaim: "none",
      scenarios,
      notes: [
        "Scripted model. Rows are not DeepSeek latency, tokens, cache, or cost.",
        "Planning off and on use the same v4 session prefix. The difference is whether the script calls the goal tools.",
        "A task with no goal still finishes when the model stops. A stored goal finishes only after every required check is verified.",
        "Token totals are the scripted usage attached to each model turn. Cache was not measured.",
        "Parallel children sleep 350 ms and share the parent workspace.",
        "A crash that leaves a child running is not replayed. This bench does not claim exactly-once execution.",
      ],
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function renderPlanningMarkdown(report: PlanningReport): string {
  const lines = [
    "# Linco planning",
    "",
    `Created: ${report.createdAt}`,
    "Mode: offline",
    "Performance claim: none. Scripted turns are not a DeepSeek ranking.",
    "",
    "| Scenario | Mode | OK | Status | Duration ms | Turns | Input | Output |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const row of report.scenarios) {
    lines.push(
      `| ${row.id} | ${row.mode} | ${row.ok ? "yes" : "no"} | ${row.status} | ${row.durationMs} | ${row.turns} | ${row.tokens.input} | ${row.tokens.output} |`,
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

async function runDependent(dataDir: string, skillsDir: string): Promise<PlanningScenario> {
  const started = Date.now();
  const harness = harnessFor(dataDir, skillsDir, 2, planStream("dependent"));
  harness.start();
  try {
    const user = harness.createUser("Ada");
    const session = harness.createSession(user.id);
    const task = await harness.submit(session.id, "Write the comparison in order.", { waitMs: 8_000 });
    const goal = task.goal;
    const children = harness.db.listChildren(task.id);
    const first = children.find((child) => child.prompt.includes("STEP_OK a"));
    const second = children.find((child) => child.prompt.includes("STEP_OK b"));
    let detail: string | undefined;
    if (task.status !== "succeeded") detail = `parent ${task.status} ${task.error ?? ""}`;
    else if (!goal || goal.steps.find((step) => step.id === "a")?.status !== "done") detail = "step a did not verify";
    else if (goal.steps.find((step) => step.id === "b")?.status !== "done") detail = "step b did not verify";
    else if (!first?.finishedAt || !second?.startedAt || Date.parse(second.startedAt) < Date.parse(first.finishedAt)) detail = "b started before a finished";
    else if (users(harness, session.id) !== 1) detail = "user message was sent again";
    return row("dependent", "on", harness, [task, ...children], detail, Date.now() - started);
  } finally {
    await harness.stop();
  }
}

async function runParallel(dataDir: string, skillsDir: string): Promise<PlanningScenario> {
  const started = Date.now();
  const harness = harnessFor(dataDir, skillsDir, 2, planStream("parallel"));
  harness.start();
  try {
    const user = harness.createUser("Ada");
    const session = harness.createSession(user.id);
    const task = await harness.submit(session.id, "Research the two notes.", { waitMs: 8_000 });
    const overlap = readOverlap(user.workspacePath);
    const goal = task.goal;
    let detail: string | undefined;
    if (task.status !== "succeeded") detail = `parent ${task.status} ${task.error ?? ""}`;
    else if (!overlapped(overlap)) detail = "independent steps did not overlap";
    else if (goal?.steps.filter((step) => step.status === "done").length !== 2) detail = "both steps were not verified";
    return row("parallel", "on", harness, [task, ...harness.db.listChildren(task.id)], detail, Date.now() - started);
  } finally {
    await harness.stop();
  }
}

async function runMissing(dataDir: string, skillsDir: string): Promise<PlanningScenario> {
  const started = Date.now();
  const harness = harnessFor(dataDir, skillsDir, 1, planStream("missing"));
  harness.start();
  try {
    const user = harness.createUser("Ada");
    const session = harness.createSession(user.id);
    const task = await harness.submit(session.id, "Claim the note exists.", { waitMs: 8_000 });
    const file = path.join(user.workspacePath, "notes", "out.txt");
    let detail: string | undefined;
    if (task.status === "succeeded") detail = "missing evidence was treated as success";
    else if (!String(task.error).includes("unverified")) detail = task.error ?? task.status;
    else if (fs.existsSync(file)) detail = "the missing file was created";
    return row("missing-evidence", "on", harness, [task], detail, Date.now() - started);
  } finally {
    await harness.stop();
  }
}

async function runReplan(dataDir: string, skillsDir: string): Promise<PlanningScenario> {
  const started = Date.now();
  const harness = harnessFor(dataDir, skillsDir, 2, planStream("replan"));
  harness.start();
  try {
    const user = harness.createUser("Ada");
    const session = harness.createSession(user.id);
    const task = await harness.submit(session.id, "Recover the failed note.", { waitMs: 8_000 });
    const goal = task.goal;
    const children = harness.db.listChildren(task.id);
    const transcript = JSON.stringify(harness.db.getTranscript(session.id));
    let detail: string | undefined;
    if (task.status !== "succeeded") detail = `parent ${task.status} ${task.error ?? ""}`;
    else if (goal?.steps.find((step) => step.id === "a")?.status !== "done") detail = "finished step a was not kept";
    else if (goal.steps.find((step) => step.id === "b")?.status !== "replaced") detail = "failed step b was not kept as replaced";
    else if (goal.steps.find((step) => step.id === "c")?.status !== "done") detail = "replacement c did not verify";
    else if (children.filter((child) => child.prompt.includes("STEP_OK a")).length !== 1) detail = "step a was spawned again";
    else if (!transcript.includes("same failure")) detail = "the repeated replan was accepted";
    return row("replan", "on", harness, [task, ...children], detail, Date.now() - started);
  } finally {
    await harness.stop();
  }
}

async function runPreserve(dataDir: string, skillsDir: string): Promise<PlanningScenario> {
  const started = Date.now();
  const harness = harnessFor(dataDir, skillsDir, 2, planStream("preserve"));
  harness.start();
  let goal: GoalPlan | null = null;
  let taskId = "";
  try {
    const user = harness.createUser("Ada");
    const session = harness.createSession(user.id);
    const task = await harness.submit(session.id, "Keep this plan.");
    taskId = task.id;
    const parked = await poll(harness, task.id, "waiting_children", 4_000);
    goal = harness.db.getTask(task.id)?.goal ?? null;
    harness.cancel(task.id);
    const cancelled = await harness.waitForTask(task.id, 4_000);
    if (!parked) return row("preserve", "on", harness, [cancelled], "parent did not park", Date.now() - started);
    if (cancelled.status !== "cancelled") return row("preserve", "on", harness, [cancelled], cancelled.status, Date.now() - started);
  } finally {
    await harness.stop();
  }
  const next = harnessFor(dataDir, skillsDir, 1, planStream("preserve"));
  try {
    const stored = next.db.getTask(taskId);
    const same = Boolean(goal && stored?.goal && stored.goal.goal === goal.goal && stored.goal.steps.every((step, index) => step.id === goal?.steps[index]?.id));
    const detail = same ? undefined : "reopen lost the plan";
    return row("preserve", "on", next, stored ? [stored] : [], detail, Date.now() - started);
  } finally {
    await next.stop();
  }
}

async function runChecklist(dataDir: string, skillsDir: string): Promise<PlanningScenario> {
  const started = Date.now();
  const harness = harnessFor(dataDir, skillsDir, 1, planStream("checklist"));
  harness.start();
  try {
    const user = harness.createUser("Ada");
    const session = harness.createSession(user.id);
    const task = await harness.submit(session.id, "Check the short list.", { waitMs: 8_000 });
    let detail: string | undefined;
    if (task.status !== "succeeded") detail = task.status;
    else if (task.goal) detail = "checklist opened a goal";
    else if (task.plan?.length !== 1 || task.plan[0]?.status !== "done") detail = "plan_write checklist was not stored";
    return row("checklist", "off", harness, [task], detail, Date.now() - started);
  } finally {
    await harness.stop();
  }
}

async function runCompare(dataDir: string, skillsDir: string, id: string, mode: "on" | "off"): Promise<PlanningScenario> {
  const started = Date.now();
  const harness = harnessFor(dataDir, skillsDir, 1, compareStream(mode));
  harness.start();
  try {
    const user = harness.createUser("Ada");
    const session = harness.createSession(user.id);
    const task = await harness.submit(session.id, "Write notes/out.txt with pear.", { waitMs: 8_000 });
    const file = path.join(user.workspacePath, "notes", "out.txt");
    const body = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    let detail: string | undefined;
    if (task.status !== "succeeded") detail = `${task.status} ${task.error ?? ""}`;
    else if (!body.includes("pear")) detail = "file missed pear";
    return { ...row(`${id}-${mode}`, mode, harness, [task], detail, Date.now() - started), id: `${id}-${mode}` };
  } finally {
    await harness.stop();
  }
}

async function runClaim(dataDir: string, skillsDir: string, mode: "on" | "off"): Promise<PlanningScenario> {
  const started = Date.now();
  const harness = harnessFor(dataDir, skillsDir, 1, claimStream(mode));
  harness.start();
  try {
    const user = harness.createUser("Ada");
    const session = harness.createSession(user.id);
    const task = await harness.submit(session.id, "Say the note is written.", { waitMs: 8_000 });
    let detail: string | undefined;
    if (mode === "off" && task.status !== "succeeded") detail = task.status;
    if (mode === "on" && task.status !== "failed") detail = `planning accepted an unverified claim (${task.status})`;
    if (mode === "on" && task.status === "failed" && !String(task.error).includes("unverified")) detail = task.error ?? "missing unverified";
    return row(`compare-claim-${mode}`, mode, harness, [task], detail, Date.now() - started);
  } finally {
    await harness.stop();
  }
}

function planStream(kind: "dependent" | "parallel" | "missing" | "replan" | "preserve" | "checklist"): StreamFn {
  return scriptedReply((messages) => {
    const latest = latestUser(messages);
    if (latest.includes("GOAL_STEP")) return childStep(latest, messages);
    const calls = countCalls(messages);
    if (kind === "checklist") {
      if (calls("plan_write") === 0) return call("plan_write", { steps: [{ id: "1", title: "Write", status: "done" }] });
      return say("checklist kept");
    }
    if (kind === "missing") {
      if (calls("goal_set") === 0) return call("goal_set", { goal: "The note exists", steps: [fileStep("a", "Write the note")] });
      if (calls("goal_evidence") === 0) return call("goal_evidence", { stepId: "a" });
      return say("done");
    }
    if (kind === "dependent") {
      if (calls("goal_set") === 0) {
        return call("goal_set", {
          goal: "Compare after both notes",
          steps: [childStepDraft("a", "STEP_OK a", []), childStepDraft("b", "STEP_OK b", ["a"])],
        });
      }
      if (calls("goal_dispatch") === 0) return call("goal_dispatch", {});
      if (calls("goal_evidence") === 0) return call("goal_evidence", { stepId: "a" });
      if (calls("goal_dispatch") === 1) return call("goal_dispatch", {});
      if (calls("goal_evidence") === 1) return call("goal_evidence", { stepId: "b" });
      return say("report ready");
    }
    if (kind === "parallel" || kind === "preserve") {
      if (calls("goal_set") === 0) {
        return call("goal_set", {
          goal: "Two independent notes",
          steps: [childStepDraft("a", "STEP_SLEEP a", []), childStepDraft("b", "STEP_SLEEP b", [])],
        });
      }
      if (calls("goal_dispatch") === 0) return call("goal_dispatch", {});
      if (kind === "preserve") return say("should have been cancelled");
      if (calls("goal_evidence") === 0) return call("goal_evidence", { stepId: "a" });
      if (calls("goal_evidence") === 1) return call("goal_evidence", { stepId: "b" });
      return say("both notes");
    }
    if (calls("goal_set") === 0) {
      return call("goal_set", {
        goal: "Replace the failed note",
        replanBudget: 2,
        steps: [childStepDraft("a", "STEP_OK a", []), childStepDraft("b", "STEP_FAIL b", [])],
      });
    }
    if (calls("goal_dispatch") === 0) return call("goal_dispatch", {});
    if (calls("goal_evidence") === 0) return call("goal_evidence", { stepId: "a" });
    if (calls("goal_evidence") === 1) return call("goal_evidence", { stepId: "b" });
    if (calls("goal_replan") === 0) return call("goal_replan", { stepId: "b", steps: [childStepDraft("c", "STEP_OK c", ["a"])] });
    if (calls("goal_dispatch") === 1) return call("goal_dispatch", {});
    if (calls("goal_evidence") === 2) return call("goal_evidence", { stepId: "c" });
    if (calls("goal_replan") === 1) return call("goal_replan", { stepId: "b", steps: [childStepDraft("d", "STEP_OK d", ["a"])] });
    return say("recovered");
  });
}

function compareStream(mode: "on" | "off"): StreamFn {
  return scriptedReply((messages) => {
    const calls = countCalls(messages);
    if (mode === "on" && calls("goal_set") === 0) return call("goal_set", { goal: "Write the pear note", steps: [fileStep("a", "Write pear")] });
    if (calls("fs_write") === 0) return call("fs_write", { path: "notes/out.txt", content: "pear" });
    if (mode === "on" && calls("goal_evidence") === 0) return call("goal_evidence", { stepId: "a" });
    return say("wrote pear");
  });
}

function claimStream(mode: "on" | "off"): StreamFn {
  return scriptedReply((messages) => {
    const calls = countCalls(messages);
    if (mode === "on" && calls("goal_set") === 0) return call("goal_set", { goal: "The note exists", steps: [fileStep("a", "Write the note")] });
    if (mode === "on" && calls("goal_evidence") === 0) return call("goal_evidence", { stepId: "a" });
    return say("done");
  });
}

function childStep(latest: string, messages: { role: string }[]): ScriptStep {
  if (latest.includes("STEP_FAIL")) throw new Error("child failed");
  if (latest.includes("STEP_SLEEP")) {
    if (messages.at(-1)?.role === "toolResult") return say("slept");
    return call("shell_exec", { command: sleepCommand(latest.includes("STEP_SLEEP a") ? "a" : "b") });
  }
  return say("found");
}

function childStepDraft(id: string, title: string, dependsOn: string[]) {
  return {
    id,
    title,
    dependsOn,
    expectedOutput: title,
    criteria: [{ id: `${id}-child`, description: "child succeeded", required: true, check: { kind: "child_succeeded" } }],
  };
}

function fileStep(id: string, title: string) {
  return {
    id,
    title,
    dependsOn: [],
    expectedOutput: "notes/out.txt contains pear",
    criteria: [{ id: `${id}-file`, description: "file contains pear", required: true, check: { kind: "file_contains", path: "notes/out.txt", text: "pear" } }],
  };
}

function call(name: string, args: Record<string, unknown>): ScriptStep {
  return { calls: [{ name, arguments: args as never }], usage: USAGE };
}

function say(text: string): ScriptStep {
  return { text, usage: USAGE };
}

function countCalls(messages: { role: string }[]): (name: string) => number {
  return (name: string) =>
    messages.reduce((total, message) => {
      if (message.role !== "assistant" || !Array.isArray((message as { content?: unknown }).content)) return total;
      const content = (message as unknown as { content: Array<{ type?: string; name?: string }> }).content;
      return total + content.filter((part) => part.type === "toolCall" && part.name === name).length;
    }, 0);
}

function latestUser(messages: { role: string }[]): string {
  return JSON.stringify([...messages].reverse().find((message) => message.role === "user") ?? {});
}

function sleepCommand(name: string): string {
  return `node -e "const fs=require('fs'); fs.appendFileSync('overlap.txt', Date.now()+' start ${name}\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${SLEEP_MS}); fs.appendFileSync('overlap.txt', Date.now()+' end ${name}\\n');"`;
}

function readOverlap(workspace: string): string {
  const file = path.join(workspace, "overlap.txt");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function overlapped(text: string): boolean {
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
  const second = starts[1];
  return second !== undefined && ends.length > 0 && second < Math.min(...ends);
}

function users(harness: Harness, sessionId: string): number {
  return harness.db.getTranscript(sessionId).filter((message) => message.role === "user").length;
}

function harnessFor(dataDir: string, skillsDir: string, workerCount: number, streamFn: StreamFn): Harness {
  return new Harness({
    config: loadConfig({ dataDir, skillsDir, workerCount, schedulerIntervalMs: 60_000, port: 0 }),
    model: SCRIPT_MODEL,
    streamFn,
  });
}

function row(id: string, mode: "on" | "off", harness: Harness, tasks: Task[], detail: string | undefined, durationMs: number): PlanningScenario {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  let turns = 0;
  for (const task of tasks) {
    const usage = harness.db.usageSummary(task.id);
    turns += usage.turns;
    tokens.input += usage.inputTokens;
    tokens.output += usage.outputTokens;
    tokens.cacheRead += usage.cacheReadTokens;
    tokens.cacheWrite += usage.cacheWriteTokens;
    tokens.costUsd += usage.costUsd;
  }
  return {
    id,
    ok: detail === undefined,
    mode,
    durationMs,
    status: tasks[0]?.status ?? "missing",
    turns,
    tokens,
    detail: detail ?? "passed",
  };
}

async function poll(harness: Harness, taskId: string, status: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = harness.db.getTask(taskId);
    if (task?.status === status && task.workerId === null) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

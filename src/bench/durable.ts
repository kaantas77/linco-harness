import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Harness } from "../agent/runtime.js";
import { loadConfig } from "../config.js";
import { LincoDb } from "../db/database.js";
import { SCRIPT_MODEL, scriptedReply } from "../llm/scripted.js";
import type { Task } from "../types.js";

export interface DurableCase {
  id: string;
  processes: number;
  ok: boolean;
  tasks: number;
  claimCallNs: number | null;
  queueWaitMs: number | null;
  recoveryMs: number | null;
  renewNs: number | null;
  doubleRuns: number;
  lostTranscripts: number;
  lockWaits: number;
  parentChildRate: number | null;
  detail: string;
}

export interface DurableReport {
  createdAt: string;
  mode: "offline";
  performanceClaim: "none";
  cases: DurableCase[];
  notes: string[];
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const vite = path.join(repo, "node_modules/vite-node/vite-node.mjs");
const worker = path.join(repo, "test/worker-proc.ts");

export async function runDurableBench(skillsDir: string): Promise<DurableReport> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-durable-"));
  try {
    const renew = measureRenew(path.join(root, "renew"), skillsDir);
    const one = await runPool(path.join(root, "one"), skillsDir, 1, 4);
    const two = await runPool(path.join(root, "two"), skillsDir, 2, 4);
    const safe = await crashCase(path.join(root, "safe"), skillsDir, "hold", "succeeded");
    const uncertain = await crashCase(path.join(root, "uncertain"), skillsDir, "write-hold", "needs_inspection");
    const family = await familyCase(path.join(root, "family"), skillsDir);
    const overlap = await overlapCase(path.join(root, "overlap"), skillsDir);
    return {
      createdAt: new Date().toISOString(),
      mode: "offline",
      performanceClaim: "none",
      cases: [renew, one, two, safe, uncertain, family, overlap],
      notes: [
        "Scripted workers. No DeepSeek call.",
        "A lease is 800 ms in the crash cases and 15000 ms otherwise. Heartbeats keep a live worker's lease.",
        "needs_inspection means an uncertain tool already ran. The task is not queued again.",
        "Exactly-once is not claimed. The fence stops a stale worker from writing. It does not roll back a file that was already written.",
        "Two processes share one SQLite file on this machine. A network filesystem is not part of this measurement.",
        "claimCallNs is one direct claim. queueWaitMs is the median time from enqueue to started_at.",
      ],
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function renderDurableMarkdown(report: DurableReport): string {
  const lines = [
    "# Linco durable workers",
    "",
    `Mode: ${report.mode}. Performance claim: ${report.performanceClaim}.`,
    "",
    "| case | processes | ok | tasks | claim ns | queue ms | recovery ms | renew ns | double runs | lost transcripts | locks | parent/child | detail |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const row of report.cases) {
    lines.push(
      `| ${row.id} | ${row.processes} | ${row.ok ? "yes" : "no"} | ${row.tasks} | ${num(row.claimCallNs)} | ${num(row.queueWaitMs)} | ${num(row.recoveryMs)} | ${num(row.renewNs)} | ${row.doubleRuns} | ${row.lostTranscripts} | ${row.lockWaits} | ${row.parentChildRate === null ? "" : row.parentChildRate} | ${row.detail} |`,
    );
  }
  lines.push("", "## Notes", "");
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push("");
  return lines.join("\n");
}

function measureRenew(dataDir: string, skillsDir: string): DurableCase {
  const harness = open(dataDir, skillsDir);
  const user = harness.createUser("renew");
  const session = harness.createSession(user.id);
  const queued = harness.db.enqueueTask({ sessionId: session.id, userId: user.id, prompt: "renew" });
  const started = process.hrtime.bigint();
  const claimed = harness.db.claimTask("renew", 15_000);
  const claimCallNs = Number(process.hrtime.bigint() - started);
  if (!claimed) {
    harness.db.close();
    return blank("renew", 0, false, "claim returned nothing");
  }
  for (let index = 0; index < 50; index += 1) harness.db.renewLease(claimed.id, claimed.fence, "renew", 15_000);
  const stats = harness.db.leaseStats();
  const again = harness.db.claimTask("other", 15_000);
  const stale = harness.db.setTranscript(session.id, [{ role: "user", content: "STALE", timestamp: 1 }], "stale", {
    taskId: claimed.id,
    fence: claimed.fence - 1,
    workerId: "renew",
  });
  harness.db.finishTask(claimed.id, "succeeded", { resultText: "once" }, { taskId: claimed.id, fence: claimed.fence, workerId: "renew" });
  const secondFinish = harness.db.finishTask(claimed.id, "failed", { error: "late" }, {
    taskId: claimed.id,
    fence: claimed.fence,
    workerId: "renew",
  });
  harness.db.close();
  const ok = again === undefined && stale === false && secondFinish === false && queued.id === claimed.id;
  return {
    ...blank("renew", 0, ok, ok ? "direct claim, fifty renewals, stale fence rejected" : "fence or claim check failed"),
    tasks: 1,
    claimCallNs,
    renewNs: stats.renews > 0 ? Math.round(stats.renewNs / stats.renews) : null,
    lockWaits: stats.lockWaits,
    doubleRuns: secondFinish ? 1 : 0,
  };
}

async function runPool(dataDir: string, skillsDir: string, processes: number, tasks: number): Promise<DurableCase> {
  const harness = open(dataDir, skillsDir);
  const ids: string[] = [];
  for (let index = 0; index < tasks; index += 1) {
    const user = harness.createUser(`pool-${index}`);
    const session = harness.createSession(user.id);
    const task = harness.db.enqueueTask({ sessionId: session.id, userId: user.id, prompt: `task ${index}` });
    ids.push(task.id);
  }
  await harness.stop();
  const children = Array.from({ length: processes }, () =>
    spawnWorker(dataDir, skillsDir, "pace", { LINCO_HOLD_MS: "200", LINCO_LEASE_MS: "15000" }),
  );
  const db = new LincoDb(path.join(dataDir, "linco.sqlite"));
  try {
    const done = await waitAll(db, ids, (task) => task.status === "succeeded" || task.status === "failed", 8_000);
    const waits = done.map((task) => (task.startedAt ? Date.parse(task.startedAt) - Date.parse(task.createdAt) : 0));
    const lost = done.filter((task) => !JSON.stringify(db.getTranscript(task.sessionId)).includes("done ")).length;
    const workers = new Set(done.map((task) => task.workerId).filter((id): id is string => Boolean(id)));
    const ok = done.every((task) => task.status === "succeeded") && workers.size === processes;
    return {
      ...blank("pool-" + processes, processes, ok, ok ? `${processes} process pool` : `statuses ${done.map((task) => task.status).join(",")}`),
      tasks,
      queueWaitMs: median(waits),
      lostTranscripts: lost,
      doubleRuns: done.filter((task) => task.attempt > 0).length,
    };
  } finally {
    db.close();
    await stopAll(children);
  }
}

async function crashCase(dataDir: string, skillsDir: string, role: "hold" | "write-hold", expect: "succeeded" | "needs_inspection"): Promise<DurableCase> {
  const harness = open(dataDir, skillsDir);
  const user = harness.createUser(role);
  const session = harness.createSession(user.id);
  const task = harness.db.enqueueTask({ sessionId: session.id, userId: user.id, prompt: role });
  await harness.stop();
  const holder = spawnWorker(dataDir, skillsDir, role, { LINCO_LEASE_MS: "800", LINCO_HEARTBEAT_MS: "150" });
  const children = [holder];
  const db = new LincoDb(path.join(dataDir, "linco.sqlite"));
  try {
    const running = await waitFor(db, task.id, (item) => item.status === "running", 4_000);
    if (role === "write-hold") await waitFile(path.join(user.workspacePath, "note.txt"), 4_000);
    const fence = running?.fence ?? 0;
    const workerId = running?.workerId ?? "";
    holder.kill("SIGKILL");
    await onceExit(holder);
    const killed = Date.now();
    const recovery = spawnWorker(dataDir, skillsDir, "recover", { LINCO_LEASE_MS: "800", LINCO_HEARTBEAT_MS: "150" });
    children.push(recovery);
    const settled = await waitFor(db, task.id, (item) => item.status === expect, 6_000);
    const recoveryMs = Date.now() - killed;
    const stale = db.setTranscript(session.id, [{ role: "user", content: "STALE", timestamp: 1 }], "stale", {
      taskId: task.id,
      fence,
      workerId,
    });
    const body = fs.existsSync(path.join(user.workspacePath, "note.txt"))
      ? fs.readFileSync(path.join(user.workspacePath, "note.txt"), "utf8").trim()
      : "";
    const transcript = JSON.stringify(db.getTranscript(session.id));
    const lost = expect === "succeeded" && !transcript.includes("recovered") ? 1 : transcript.includes("STALE") ? 1 : 0;
    const ok =
      settled?.status === expect &&
      stale === false &&
      lost === 0 &&
      (role === "hold" || body === "once") &&
      db.listChildren(task.id).length === 0;
    return {
      ...blank(role, 2, ok, ok ? `settled ${settled?.status}` : `status ${settled?.status ?? "missing"} file ${body || "none"}`),
      tasks: 1,
      recoveryMs,
      lostTranscripts: lost,
      doubleRuns: settled?.status === "succeeded" && role === "write-hold" ? 1 : 0,
    };
  } finally {
    db.close();
    await stopAll(children);
  }
}

async function familyCase(dataDir: string, skillsDir: string): Promise<DurableCase> {
  const harness = open(dataDir, skillsDir);
  const user = harness.createUser("family");
  const session = harness.createSession(user.id);
  const task = harness.db.enqueueTask({ sessionId: session.id, userId: user.id, prompt: "Park the child, then stop." });
  await harness.stop();
  const holder = spawnWorker(dataDir, skillsDir, "parent", {
    LINCO_LEASE_MS: "800",
    LINCO_HEARTBEAT_MS: "150",
    LINCO_WORKER_COUNT: "2",
    LINCO_HOLD_MS: "30000",
  });
  const childrenProcs = [holder];
  const db = new LincoDb(path.join(dataDir, "linco.sqlite"));
  try {
    const parked = await waitFor(db, task.id, (item) => item.status === "waiting_children", 6_000);
    const childRunning = parked ? db.listChildren(task.id).some((child) => child.status === "running") : false;
    holder.kill("SIGKILL");
    await onceExit(holder);
    const killed = Date.now();
    const recovery = spawnWorker(dataDir, skillsDir, "parent", {
      LINCO_LEASE_MS: "800",
      LINCO_HEARTBEAT_MS: "150",
      LINCO_WORKER_COUNT: "2",
      LINCO_RECOVER: "1",
    });
    childrenProcs.push(recovery);
    const done = await waitFor(db, task.id, (item) => item.status === "succeeded" || item.status === "failed" || item.status === "needs_inspection", 8_000);
    const children = db.listChildren(task.id);
    const rate = done?.status === "succeeded" && children.length === 1 && children[0]?.status === "succeeded" ? 1 : 0;
    const ok = childRunning && rate === 1 && (done?.resultText ?? "").includes("parent-done");
    return {
      ...blank("parent-child", 2, ok, ok ? "child recovered once and the parent continued" : `parent ${done?.status} children ${children.map((child) => child.status).join(",")}`),
      tasks: 1 + children.length,
      recoveryMs: Date.now() - killed,
      parentChildRate: rate,
      doubleRuns: children.length > 1 ? children.length - 1 : 0,
    };
  } finally {
    db.close();
    await stopAll(childrenProcs);
  }
}

async function overlapCase(dataDir: string, skillsDir: string): Promise<DurableCase> {
  const harness = open(dataDir, skillsDir);
  const user = harness.createUser("overlap");
  const session = harness.createSession(user.id);
  const first = harness.db.enqueueTask({ sessionId: session.id, userId: user.id, prompt: "first" });
  const second = harness.db.enqueueTask({ sessionId: session.id, userId: user.id, prompt: "second" });
  await harness.stop();
  const children = [spawnWorker(dataDir, skillsDir, "hold", { LINCO_HOLD_MS: "500", LINCO_LEASE_MS: "15000" }), spawnWorker(dataDir, skillsDir, "hold", { LINCO_HOLD_MS: "500", LINCO_LEASE_MS: "15000" })];
  const db = new LincoDb(path.join(dataDir, "linco.sqlite"));
  try {
    const done = await waitAll(db, [first.id, second.id], (task) => task.status === "succeeded" || task.status === "failed", 8_000);
    const ordered = [...done].sort((left, right) => Date.parse(left.startedAt ?? left.createdAt) - Date.parse(right.startedAt ?? right.createdAt));
    const left = ordered[0];
    const right = ordered[1];
    const separated = Boolean(left?.finishedAt && right?.startedAt && Date.parse(right.startedAt) >= Date.parse(left.finishedAt));
    const ok = done.every((task) => task.status === "succeeded") && separated;
    return {
      ...blank("same-session", 2, ok, ok ? "the second task waited for the first" : "the session ran on two workers at once"),
      tasks: 2,
      doubleRuns: separated ? 0 : 1,
    };
  } finally {
    db.close();
    await stopAll(children);
  }
}

function open(dataDir: string, skillsDir: string): Harness {
  return new Harness({
    config: loadConfig({ dataDir, skillsDir, workerCount: 0, schedulerIntervalMs: 60_000, port: 0 }),
    model: SCRIPT_MODEL,
    streamFn: scriptedReply(() => ({ text: "unused" })),
  });
}

function spawnWorker(dataDir: string, skillsDir: string, role: string, env: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn(process.execPath, [vite, worker, dataDir, skillsDir, role], {
    cwd: repo,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitFor(db: LincoDb, id: string, pred: (task: Task) => boolean, timeoutMs: number): Promise<Task | undefined> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = db.getTask(id);
    if (task && pred(task)) return task;
    await sleep(30);
  }
  return db.getTask(id);
}

async function waitAll(db: LincoDb, ids: string[], pred: (task: Task) => boolean, timeoutMs: number): Promise<Task[]> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tasks = ids.map((id) => db.getTask(id)).filter((task): task is Task => Boolean(task));
    if (tasks.length === ids.length && tasks.every(pred)) return tasks;
    await sleep(30);
  }
  return ids.map((id) => db.getTask(id)).filter((task): task is Task => Boolean(task));
}

async function waitFile(file: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) return;
    await sleep(20);
  }
}

function onceExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function stopAll(children: ChildProcess[]): Promise<void> {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(children.map((child) => onceExit(child)));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function blank(id: string, processes: number, ok: boolean, detail: string): DurableCase {
  return {
    id,
    processes,
    ok,
    tasks: 0,
    claimCallNs: null,
    queueWaitMs: null,
    recoveryMs: null,
    renewNs: null,
    doubleRuns: 0,
    lostTranscripts: 0,
    lockWaits: 0,
    parentChildRate: null,
    detail,
  };
}

function num(value: number | null): string {
  return value === null ? "" : String(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

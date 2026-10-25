import fs from "node:fs";
import path from "node:path";
import { createGoal } from "../src/agent/goal.js";
import { Harness } from "../src/agent/runtime.js";
import { loadConfig } from "../src/config.js";
import { SCRIPT_MODEL, scriptedDelay, scriptedReply, type StreamFn } from "../src/llm/scripted.js";

const dataDir = process.argv[2];
const skillsDir = process.argv[3];
const role = process.argv[4] ?? "fast";
if (!dataDir || !skillsDir) throw new Error("usage: worker-proc.ts <dataDir> <skillsDir> <role>");

if (role === "fence") {
  await fenceRole(dataDir, skillsDir);
} else {
  startWorker(dataDir, skillsDir, role);
}

function startWorker(dir: string, skills: string, kind: string): void {
  const recover = process.env.LINCO_RECOVER === "1";
  const holdMs = Number(process.env.LINCO_HOLD_MS ?? 30_000);
  const workerCount = Number(process.env.LINCO_WORKER_COUNT ?? (kind === "parent" ? 2 : 1));
  const harness = new Harness({
    config: loadConfig({
      dataDir: dir,
      skillsDir: skills,
      workerCount,
      schedulerIntervalMs: 60_000,
      port: 0,
      authMode: "dev",
      manageCredentials: false,
      allowLoopback: true,
      sandbox: "require",
    }),
    model: SCRIPT_MODEL,
    streamFn: streamFor(kind, recover, holdMs),
  });
  harness.start();
  setInterval(() => undefined, 60_000);
}

async function fenceRole(dir: string, skills: string): Promise<void> {
  const harness = new Harness({
    config: loadConfig({
      dataDir: dir,
      skillsDir: skills,
      workerCount: 0,
      schedulerIntervalMs: 60_000,
      port: 0,
      leaseMs: 300,
      heartbeatMs: 60_000,
      authMode: "dev",
      manageCredentials: false,
      sandbox: "off",
    }),
    model: SCRIPT_MODEL,
    streamFn: scriptedReply(() => ({ text: "unused" })),
  });
  const workerId = `fence_${process.pid}`;
  const claimed = harness.db.claimTask(workerId, 300);
  if (!claimed?.workerId) {
    fs.writeFileSync(path.join(dir, "fence-result.json"), `${JSON.stringify({ error: "no claim" })}\n`);
    await harness.stop();
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  const claim = { taskId: claimed.id, fence: claimed.fence, workerId: claimed.workerId };
  const goal = createGoal("stale", [
    {
      id: "a",
      title: "A",
      expectedOutput: "a",
      criteria: [{ id: "c", description: "file", check: { kind: "file_exists", path: "a.txt" } }],
    },
  ]);
  const goalOk = harness.db.setGoal(claimed.id, goal, claim);
  const planOk = harness.db.setPlan(claimed.id, [{ id: "a", title: "A", status: "pending" }], claim);
  const child = harness.db.dispatchOwned(claim, {
    userId: claimed.userId,
    skills: harness.skills,
    systemPrompt: "stale",
    prompts: ["do not run"],
  });
  const transcript = harness.db.setTranscript(
    claimed.sessionId,
    [{ role: "user", content: "stale-write", timestamp: 1 }] as never,
    "stale",
    claim,
  );
  const task = harness.db.getTask(claimed.id);
  fs.writeFileSync(
    path.join(dir, "fence-result.json"),
    `${JSON.stringify({
      goalOk,
      planOk,
      child: "error" in child ? child.error : child.tasks.length,
      transcript,
      children: harness.db.listChildren(claimed.id).length,
      goal: task?.goal?.goal ?? null,
      plan: task?.plan ?? null,
    })}\n`,
  );
  await harness.stop();
  process.exit(0);
}

function streamFor(kind: string, childRecovers: boolean, pauseMs: number): StreamFn {
  if (kind === "hold") return scriptedDelay(pauseMs, { text: "held" });
  if (kind === "pace") return scriptedDelay(pauseMs, { text: `done ${process.pid}` });
  if (kind === "recover") return scriptedReply(() => ({ text: "recovered" }));
  if (kind === "write-hold") {
    return (model, context) => {
      const seen = context.messages.some((message) => message.role === "toolResult");
      if (!seen) {
        return scriptedReply(() => ({ calls: [{ name: "fs_write", arguments: { path: "note.txt", content: "once" } }] }))(model, context);
      }
      return scriptedDelay(pauseMs, { text: "held" })(model, context);
    };
  }
  if (kind === "parent") return parentStream(childRecovers, pauseMs);
  return scriptedReply(() => ({ text: `done ${process.pid}` }));
}

function parentStream(childRecovers: boolean, pauseMs: number): StreamFn {
  return (model, context) => {
    const messages = context.messages as Array<{ role: string }>;
    const latest = JSON.stringify([...messages].reverse().find((message) => message.role === "user") ?? {});
    if (latest.includes("CHILD_HOLD")) {
      if (childRecovers) return scriptedReply(() => ({ text: "child-ok" }))(model, context);
      return scriptedDelay(pauseMs, { text: "child-ok" })(model, context);
    }
    const blob = JSON.stringify(messages.filter((message) => message.role === "assistant" || message.role === "toolResult"));
    if (!blob.includes("task_spawn")) {
      return scriptedReply(() => ({ calls: [{ name: "task_spawn", arguments: { prompt: "CHILD_HOLD" } }] }))(model, context);
    }
    if (!blob.includes("task_wait")) {
      const ids = [...blob.matchAll(/queued (task_[0-9a-f-]+)/g)].map((match) => match[1]).filter((id): id is string => Boolean(id));
      return scriptedReply(() => ({ calls: ids.map((taskId) => ({ name: "task_wait", arguments: { taskId } })) }))(model, context);
    }
    return scriptedReply(() => ({ text: "parent-done" }))(model, context);
  };
}

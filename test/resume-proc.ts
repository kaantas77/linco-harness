import fs from "node:fs";
import path from "node:path";
import { Harness } from "../src/agent/runtime.js";
import { loadConfig } from "../src/config.js";
import { SCRIPT_MODEL, scriptedReply } from "../src/llm/scripted.js";

const dataDir = process.argv[2];
const skillsDir = process.argv[3];
if (!dataDir || !skillsDir) throw new Error("usage: resume-proc.ts <dataDir> <skillsDir>");

const sleep = `node -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000)"`;
const stream = scriptedReply((messages) => {
  const latest = JSON.stringify([...messages].reverse().find((message) => message.role === "user") ?? {});
  if (latest.includes("CHILD_HOLD")) {
    if (messages.at(-1)?.role === "toolResult") return { text: "held" };
    return { calls: [{ name: "shell_exec", arguments: { command: sleep } }] };
  }
  const blob = JSON.stringify(messages.filter((message) => message.role === "assistant" || message.role === "toolResult"));
  if (!blob.includes("task_spawn")) return { calls: [{ name: "task_spawn", arguments: { prompt: "CHILD_HOLD" } }] };
  if (!blob.includes("task_wait")) {
    const ids = [...blob.matchAll(/queued (task_[0-9a-f-]+)/g)].map((match) => match[1]).filter((id): id is string => Boolean(id));
    return { calls: ids.map((taskId) => ({ name: "task_wait", arguments: { taskId } })) };
  }
  return { text: "should still be parked" };
});

const harness = new Harness({
  config: loadConfig({ dataDir, skillsDir, workerCount: 2, schedulerIntervalMs: 60_000, port: 0 }),
  model: SCRIPT_MODEL,
  streamFn: stream,
});
harness.start();
const user = harness.createUser("Ada");
const session = harness.createSession(user.id);
const task = await harness.submit(session.id, "Park until the process stops.");
const started = Date.now();
while (Date.now() - started < 8_000) {
  const current = harness.db.getTask(task.id);
  if (current?.status === "waiting_children" && current.workerId === null) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
const parked = harness.db.getTask(task.id);
fs.writeFileSync(
  path.join(dataDir, "ready.json"),
  JSON.stringify({ taskId: task.id, status: parked?.status ?? "missing", child: harness.db.listChildren(task.id).map((child) => child.status) }),
);
await new Promise(() => undefined);

import { Harness } from "../src/agent/runtime.js";
import { loadConfig } from "../src/config.js";
import { SCRIPT_MODEL, scriptedDelay, scriptedReply, type StreamFn } from "../src/llm/scripted.js";

const dataDir = process.argv[2];
const skillsDir = process.argv[3];
const role = process.argv[4] ?? "fast";
if (!dataDir || !skillsDir) throw new Error("usage: worker-proc.ts <dataDir> <skillsDir> <role>");

const recover = process.env.LINCO_RECOVER === "1";
const holdMs = Number(process.env.LINCO_HOLD_MS ?? 30_000);
const workerCount = Number(process.env.LINCO_WORKER_COUNT ?? (role === "parent" ? 2 : 1));

const harness = new Harness({
  config: loadConfig({
    dataDir,
    skillsDir,
    workerCount,
    schedulerIntervalMs: 60_000,
    port: 0,
  }),
  model: SCRIPT_MODEL,
  streamFn: streamFor(role, recover, holdMs),
});
harness.start();
setInterval(() => undefined, 60_000);

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

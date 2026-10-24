import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Harness } from "../src/agent/runtime.js";
import { loadConfig } from "../src/config.js";
import { SCRIPT_MODEL, scriptedReply, type ScriptStep } from "../src/llm/scripted.js";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("resume checkpoint", () => {
  it("retries a failed continue without a new user message or a second child", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-resume-"));
    let resumes = 0;
    const harness = harnessFor(root, retryStream(() => {
      resumes += 1;
      if (resumes === 1) throw new Error("resume failed");
      return { text: "continued once" };
    }));
    harness.start();
    try {
      const user = harness.createUser("Ada");
      const session = harness.createSession(user.id);
      const task = await harness.submit(session.id, "Write once, then wait.", { waitMs: 8_000, maxAttempts: 2 });
      const transcript = harness.db.getTranscript(session.id);
      const users = transcript.filter((message) => message.role === "user").length;
      const writes = harness.db.listTraces(task.id).filter((trace) => trace.name === "fs_write");
      const file = path.join(user.workspacePath, "durable.txt");
      expect(task.status).toBe("succeeded");
      expect(task.resultText).toContain("continued once");
      expect(task.attempt).toBe(1);
      expect(users).toBe(1);
      expect(harness.db.listChildren(task.id)).toHaveLength(1);
      expect(writes).toHaveLength(1);
      expect(fs.readFileSync(file, "utf8")).toBe("once");
      expect(task.checkpoint).toBeNull();
    } finally {
      await harness.stop();
    }
  }, 15_000);

  it("keeps the resume marker while continue is in progress, then reopens the same database", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-resume-open-"));
    let release = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const resume = scriptedReply(() => ({ text: "continued once" }));
    const harness = harnessFor(root, (model, context, options) => {
      const messages = context.messages;
      const latest = JSON.stringify([...messages].reverse().find((message) => message.role === "user") ?? {});
      if (latest.includes("CHILD_SLOW")) return retryStream(() => ({ text: "unused" }))(model, context, options);
      if (users(messages) > 1) throw new Error("resent user message");
      if (!called(messages, "task_spawn")) {
        return scriptedReply(() => ({ calls: [{ name: "task_spawn", arguments: { prompt: "CHILD_SLOW" } }] }))(model, context, options);
      }
      if (!called(messages, "task_wait")) return scriptedReply(() => waitCalls(messages))(model, context, options);
      entered = true;
      return gate.then(() => resume(model, context, options));
    });
    harness.start();
    const user = harness.createUser("Ada");
    const session = harness.createSession(user.id);
    const queued = await harness.submit(session.id, "Wait and continue.");
    const started = Date.now();
    while (!entered && Date.now() - started < 4_000) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toBe(true);
    const reader = harnessFor(root, scriptedReply(() => ({ text: "unused" })));
    try {
      const live = reader.db.getTask(queued.id);
      expect(live?.status).toBe("running");
      expect(live?.checkpoint?.resumeChildren).toBe(true);
    } finally {
      await reader.stop();
    }
    release();
    const done = await harness.waitForTask(queued.id, 8_000);
    expect(done.status).toBe("succeeded");
    expect(harness.db.getTranscript(session.id).filter((message) => message.role === "user")).toHaveLength(1);
    expect(harness.db.listChildren(done.id)).toHaveLength(1);
    await harness.stop();
    const reopened = harnessFor(root, scriptedReply(() => ({ text: "unused" })));
    try {
      const stored = reopened.db.getTask(done.id);
      expect(stored?.status).toBe("succeeded");
      expect(reopened.db.getTranscript(session.id).filter((message) => message.role === "user")).toHaveLength(1);
    } finally {
      await reopened.stop();
    }
  }, 15_000);

  it("does not finish a parked parent after the process is killed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-resume-kill-"));
    const child = spawn(
      process.execPath,
      [path.join(repo, "node_modules/vite-node/vite-node.mjs"), path.join(repo, "test/resume-proc.ts"), root, skillsDir],
      { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
    );
    let log = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
    });
    const readyPath = path.join(root, "ready.json");
    const started = Date.now();
    while (!fs.existsSync(readyPath) && Date.now() - started < 10_000) {
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(fs.existsSync(readyPath), log).toBe(true);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const harness = harnessFor(root, scriptedReply(() => ({ text: "should not run" })));
    harness.start();
    try {
      const ready = JSON.parse(fs.readFileSync(readyPath, "utf8")) as { taskId: string };
      const parent = harness.db.getTask(ready.taskId);
      expect(parent?.status).toBe("waiting_children");
      expect(harness.db.wakeParent(ready.taskId)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const after = harness.db.getTask(ready.taskId);
      expect(after?.status).toBe("waiting_children");
      expect(harness.db.listChildren(ready.taskId).some((item) => item.status === "running")).toBe(true);
    } finally {
      await harness.stop();
    }
  }, 20_000);
});

function retryStream(onResume: () => ScriptStep): StreamFn {
  return scriptedReply((messages) => {
    const latest = JSON.stringify([...messages].reverse().find((message) => message.role === "user") ?? {});
    if (latest.includes("CHILD_SLOW")) {
      if (messages.at(-1)?.role === "toolResult") return { text: "child-ok" };
      return {
        calls: [
          {
            name: "shell_exec",
            arguments: {
              command: `node -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300)"`,
            },
          },
        ],
      };
    }
    if (users(messages) > 1) throw new Error("resent user message");
    if (!called(messages, "fs_write")) return { calls: [{ name: "fs_write", arguments: { path: "durable.txt", content: "once" } }] };
    if (!called(messages, "task_spawn")) return { calls: [{ name: "task_spawn", arguments: { prompt: "CHILD_SLOW" } }] };
    if (!called(messages, "task_wait")) return waitCalls(messages);
    return onResume();
  });
}

function waitCalls(messages: { role: string }[]): ScriptStep {
  const ids = [...JSON.stringify(messages.filter((message) => message.role === "toolResult")).matchAll(/queued (task_[0-9a-f-]+)/g)]
    .map((match) => match[1])
    .filter((id): id is string => Boolean(id));
  return { calls: ids.map((taskId) => ({ name: "task_wait", arguments: { taskId } })) };
}

function called(messages: { role: string }[], name: string): boolean {
  return messages.some((message) => {
    if (message.role !== "assistant") return false;
    const content = (message as { content?: Array<{ type?: string; name?: string }> }).content;
    return Array.isArray(content) && content.some((part) => part.type === "toolCall" && part.name === name);
  });
}

function users(messages: { role: string }[]): number {
  return messages.filter((message) => message.role === "user").length;
}

function harnessFor(dataDir: string, streamFn: StreamFn): Harness {
  return new Harness({
    config: loadConfig({ dataDir, skillsDir, workerCount: 2, schedulerIntervalMs: 60_000, port: 0 }),
    model: SCRIPT_MODEL,
    streamFn,
  });
}

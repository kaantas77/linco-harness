import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Harness } from "../src/agent/runtime.js";
import { runOfflineBench } from "../src/bench/runner.js";
import { loadConfig } from "../src/config.js";
import { SCRIPT_MODEL, scriptedReply, scriptedStream } from "../src/llm/scripted.js";
import { HarnessServer } from "../src/server/http.js";
import { withHarness } from "./helpers.js";

const skillsDir = path.resolve("skills");

describe("harness", () => {
  it("writes a file, keeps the system prompt stable, and injects only the matching memory", async () => {
    await withHarness(
      async (harness) => {
        const user = harness.createUser("Ada");
        harness.db.createMemory({ userId: user.id, kind: "preference", title: "Editor", body: "prefers vim" });
        harness.db.createMemory({ userId: user.id, kind: "fact", title: "City", body: "lives in Istanbul" });
        const session = harness.createSession(user.id);
        const task = await harness.submit(session.id, "Update the editor note", { waitMs: 5_000 });
        expect(task.status).toBe("succeeded");
        expect(fs.readFileSync(path.join(user.workspacePath, "note.txt"), "utf8")).toBe("hello");
        const transcript = harness.db.getTranscript(session.id);
        const system = transcript.find((message) => message.role === "system");
        const userMessage = transcript.find((message) => message.role === "user");
        expect(system && "content" in system && system.content).toBe(session.systemPrompt);
        expect(JSON.stringify(system)).not.toContain("prefers vim");
        const userText = JSON.stringify(userMessage);
        expect(userText).toContain("prefers vim");
        expect(userText).not.toContain("Istanbul");
        const usage = harness.db.usageSummary(task.id);
        expect(usage.cacheReadTokens).toBeGreaterThan(0);
        expect(usage.cacheHitRatio).toBeGreaterThan(0);
        expect(usage.costUsd).toBeGreaterThan(0);
      },
      {
        steps: [
          { calls: [{ name: "fs_write", arguments: { path: "note.txt", content: "hello" } }], usage: usage() },
          { text: "wrote the editor note", usage: usage() },
        ],
      },
    );
  });

  it("runs an approved delete and refuses it until then", async () => {
    let turn = 0;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-"));
    const harness = new Harness({
      config: loadConfig({ dataDir, skillsDir, workerCount: 1, schedulerIntervalMs: 60_000, port: 0 }),
      model: SCRIPT_MODEL,
      streamFn: scriptedReply(() => {
        turn += 1;
        if (turn < 3) return { calls: [{ name: "fs_delete", arguments: { path: "note.txt" } }] };
        return { text: "deleted note.txt" };
      }),
    });
    harness.start();
    try {
      const user = harness.createUser("Ada");
      fs.writeFileSync(path.join(user.workspacePath, "note.txt"), "keep");
      const session = harness.createSession(user.id);
      const waiting = await harness.submit(session.id, "Delete note.txt", { waitMs: 5_000 });
      expect(waiting.status).toBe("waiting_approval");
      expect(fs.existsSync(path.join(user.workspacePath, "note.txt"))).toBe(true);
      const approval = harness.db.listApprovals(waiting.id)[0];
      expect(approval?.status).toBe("pending");
      harness.approve(waiting.id, approval!.id, "approved");
      const done = await harness.waitForTask(waiting.id, 5_000);
      expect(done.status).toBe("succeeded");
      expect(fs.existsSync(path.join(user.workspacePath, "note.txt"))).toBe(false);
    } finally {
      await harness.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("overlaps two workspace commands on two workers", async () => {
    const command =
      "node -e \"const fs=require('fs'); fs.appendFileSync('overlap.txt', Date.now()+' start\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400); fs.appendFileSync('overlap.txt', Date.now()+' end\\n');\"";
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-"));
    const harness = new Harness({
      config: loadConfig({ dataDir, skillsDir, workerCount: 2, schedulerIntervalMs: 60_000, port: 0 }),
      model: SCRIPT_MODEL,
      streamFn: scriptedReply((messages) => {
        const last = messages.at(-1);
        if (last?.role === "toolResult") return { text: "shell finished" };
        return { calls: [{ name: "shell_exec", arguments: { command } }] };
      }),
    });
    harness.start();
    try {
      const user = harness.createUser("Ada");
      const first = harness.createSession(user.id);
      const second = harness.createSession(user.id);
      await harness.submit(first.id, "run one");
      await harness.submit(second.id, "run two");
      await harness.drain(5_000);
      const lines = fs.readFileSync(path.join(user.workspacePath, "overlap.txt"), "utf8").trim().split("\n");
      const events = lines.map((line) => {
        const [stamp, kind] = line.split(" ");
        return { stamp: Number(stamp), kind };
      });
      expect(events.filter((event) => event.kind === "start")).toHaveLength(2);
      const secondStart = events.filter((event) => event.kind === "start")[1]?.stamp ?? 0;
      const firstEnd = events.find((event) => event.kind === "end")?.stamp ?? 0;
      expect(secondStart).toBeLessThan(firstEnd);
    } finally {
      await harness.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reads a local page through web_fetch", async () => {
    const page = http.createServer((_request, response) => {
      response.end("<html><body><p>Linco page</p><script>secret()</script></body></html>");
    });
    await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", () => resolve()));
    const address = page.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-web-"));
    const harness = new Harness({
      config: loadConfig({ dataDir, skillsDir, workerCount: 1, schedulerIntervalMs: 60_000, port: 0 }),
      model: SCRIPT_MODEL,
      streamFn: scriptedStream([
        { calls: [{ name: "web_fetch", arguments: { url: `http://127.0.0.1:${port}/` } }] },
        { text: "fetched the page" },
      ]),
    });
    harness.start();
    try {
      const user = harness.createUser("Ada");
      const session = harness.createSession(user.id);
      const task = await harness.submit(session.id, "Read the page", { waitMs: 5_000 });
      expect(task.status).toBe("succeeded");
      const transcript = JSON.stringify(harness.db.getTranscript(session.id));
      expect(transcript).toContain("Linco page");
      expect(transcript).not.toContain("secret()");
    } finally {
      await harness.stop();
      await new Promise<void>((resolve, reject) => page.close((error) => (error ? reject(error) : resolve())));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("enqueues cron once and accepts a webhook", async () => {
    await withHarness(async (harness) => {
      const user = harness.createUser("Ada");
      const cron = harness.createAutomation({
        userId: user.id,
        kind: "cron",
        name: "morning",
        prompt: "Check the notes",
        schedule: "0 8 * * *",
      });
      expect(cron.nextRunAt).toBeTruthy();
      harness.db.markAutomation(cron.id, "2026-10-22T08:00:00.000Z", null);
      expect(harness.tick(new Date("2026-10-22T08:00:01.000Z"))).toBe(1);
      expect(harness.tick(new Date("2026-10-22T08:00:02.000Z"))).toBe(0);
      const webhook = harness.createAutomation({
        userId: user.id,
        kind: "webhook",
        name: "alert",
        prompt: "Event {{payload}}",
      });
      const task = harness.acceptWebhook(webhook.webhookToken ?? "", { site: "example.com" });
      expect(task.prompt).toContain("example.com");
      expect(task.kind).toBe("webhook");
    });
  });
});

describe("http", () => {
  it("creates a user, stores memory, and runs a message", async () => {
    await withHarness(async (harness) => {
      const server = new HarnessServer(harness);
      const port = await server.listen(0, "127.0.0.1");
      try {
        const user = await request(port, "POST", "/v1/users", { name: "Ada" });
        const created = (await user.json()) as { id: string };
        const memory = await request(port, "POST", `/v1/users/${created.id}/memories`, {
          title: "Editor",
          body: "prefers vim",
          kind: "preference",
        });
        expect(memory.status).toBe(201);
        const listed = await request(port, "GET", `/v1/users/${created.id}/memories`);
        const memories = (await listed.json()) as { memories: Array<{ title: string }> };
        expect(memories.memories.map((item) => item.title)).toContain("Editor");
        const session = await request(port, "POST", "/v1/sessions", { userId: created.id });
        const sessionBody = (await session.json()) as { id: string };
        const posted = await request(port, "POST", `/v1/sessions/${sessionBody.id}/messages`, {
          text: "Say hello",
          waitMs: 5_000,
        });
        const task = (await posted.json()) as { status: string; id: string };
        expect(task.status).toBe("succeeded");
        const health = await request(port, "GET", "/health");
        expect((await health.json()) as { ok: boolean }).toMatchObject({ ok: true });
      } finally {
        await server.close();
      }
    });
  });
});

describe("bench", () => {
  it("passes the offline scenarios", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-bench-"));
    try {
      const rows = await runOfflineBench({ dataDir, skillsDir });
      expect(rows.every((row) => row.ok)).toBe(true);
    } finally {
      await fsPromises.rm(dataDir, { recursive: true, force: true });
    }
  });
});

function usage() {
  return {
    input: 100,
    output: 10,
    cacheRead: 300,
    cacheWrite: 0,
    totalTokens: 410,
    cost: { input: 0.00003, output: 0.000012, cacheRead: 0.0000018, cacheWrite: 0, total: 0.0000438 },
  };
}

async function request(port: number, method: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

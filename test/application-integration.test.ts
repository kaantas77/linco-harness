import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Harness } from "../src/agent/runtime.js";
import { BoatSandboxManager } from "../src/boat/manager.js";
import { LincoClient } from "../src/client/linco.js";
import { loadConfig } from "../src/config.js";
import type { LincoDb } from "../src/db/database.js";
import { SCRIPT_MODEL, scriptedReply, scriptedStream } from "../src/llm/scripted.js";
import { HarnessServer } from "../src/server/http.js";
import { FakeBoat } from "./boat-fake.js";

const skillsDir = path.resolve("skills");

describe("application integration", () => {
  it("maps an app user on the server, keeps one session, and reconnects the event stream", async () => {
    let turn = 0;
    const { port, cleanup } = await open({
      streamFn: scriptedReply(() => {
        turn += 1;
        return { text: turn === 1 ? "first reply" : "second reply" };
      }),
    });
    try {
      const client = new LincoClient(`http://127.0.0.1:${port}`);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(await health.json()).toMatchObject({ ok: true, publicReady: false, vmBrowser: false });
      const opened = await client.openAppSession("weblinco:ada");
      const first = await client.sendAppMessage("weblinco:ada", "Say hello", 5_000);
      const second = await client.sendAppMessage("weblinco:ada", "Say hello again", 5_000);
      expect(first.task.status).toBe("succeeded");
      expect(first.task.sessionId).toBe(opened.sessionId);
      expect(second.task.sessionId).toBe(opened.sessionId);
      expect(second.task.id).not.toBe(first.task.id);
      expect(first.evidence.contract).toBeNull();
      expect(credentialFree(first)).toBe(true);
      expect(credentialFree(second)).toBe(true);
      const controller = new AbortController();
      await expect(client.watch(first.task.id, {
        app: true,
        signal: controller.signal,
        onEvent: () => controller.abort(),
      })).rejects.toThrow(/aborted/);
      const again = await client.watch(first.task.id, { app: true });
      expect(again.task.status).toBe("succeeded");
      expect(again.task.resultText).toContain("first reply");
      expect(again.evidence.runs).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("runs a workspace program and reads the process evidence separately from the status", async () => {
    const { harness, port, cleanup } = await open({
      streamFn: scriptedReply((messages) => {
        const lastUser = messages.reduce((found, message, index) => (message.role === "user" ? index : found), -1);
        const ran = messages.slice(lastUser + 1).some((message) => message.role === "toolResult");
        if (!ran) {
          return {
            calls: [{
              name: "code_write_run",
              arguments: { path: "proof/app-112.mjs", source: "console.log('PHASE112-RUN')\n" },
            }],
          };
        }
        return { text: "the program printed PHASE112-RUN" };
      }),
    });
    try {
      const client = new LincoClient(`http://127.0.0.1:${port}`);
      const opened = await client.openAppSession("weblinco:coder");
      const view = await client.sendAppMessage(
        "weblinco:coder",
        "proof/app-112.mjs kodunu yaz ve node ile çalıştır. console.log('PHASE112-RUN')",
        8_000,
      );
      expect(view.task.status).toBe("succeeded");
      const evidence = await client.appTask(view.task.id);
      const run = evidence.evidence.runs.find((item) => item.name === "code_write_run");
      expect(run?.isError).toBe(false);
      expect(run?.run?.exitCode).toBe(0);
      expect(run?.run?.timedOut).toBe(false);
      expect(run?.run?.stdout).toContain("PHASE112-RUN");
      expect(run?.run?.path).toBe("proof/app-112.mjs");
      const user = harness.db.getUser(opened.userId);
      const file = fs.readFileSync(path.join(user?.workspacePath ?? "", "proof/app-112.mjs"), "utf8");
      expect(file).toContain("PHASE112-RUN");
      expect(credentialFree(evidence)).toBe(true);
      expect(evidence.evidence.contract?.token).toBe("PHASE112-RUN");
    } finally {
      await cleanup();
    }
  });

  it("keeps a Boat file across stop and resume and hides it from the other app user", async () => {
    const fake = new FakeBoat();
    let manager!: BoatSandboxManager;
    let turn = 0;
    const { port, cleanup } = await open({
      streamFn: scriptedReply(() => {
        turn += 1;
        if (turn === 1) return { calls: [{ name: "fs_write", arguments: { path: "desk/note.txt", content: "PHASE112-FILE" } }] };
        if (turn === 2) return { text: "saved PHASE112-FILE" };
        if (turn === 3) return { calls: [{ name: "fs_read", arguments: { path: "desk/note.txt" } }] };
        return { text: "the other user has no file" };
      }),
      boat: (db) => {
        manager = new BoatSandboxManager({
          client: fake,
          db,
          machineType: "small",
          ttlSeconds: 600,
          idleStopMs: 60_000,
          maxSeconds: 1200,
          vmBrowser: false,
        });
        return manager;
      },
    });
    try {
      const client = new LincoClient(`http://127.0.0.1:${port}`);
      const ada = await client.openAppSession("weblinco:ada");
      const saved = await client.sendAppMessage("weblinco:ada", "Write desk/note.txt", 5_000);
      expect(saved.task.status).toBe("succeeded");
      expect((await manager.read(ada.userId, "desk/note.txt")).text).toBe("PHASE112-FILE");
      await manager.stop(ada.userId);
      await manager.ensure(ada.userId);
      expect((await manager.read(ada.userId, "desk/note.txt")).text).toBe("PHASE112-FILE");
      expect(fake.createCalls).toBe(1);
      const bea = await client.sendAppMessage("weblinco:bea", "Read desk/note.txt", 5_000);
      expect(bea.task.userId).not.toBe(ada.userId);
      expect(bea.task.sessionId).not.toBe(ada.sessionId);
      await expect(manager.read(bea.task.userId, "desk/note.txt")).rejects.toThrow(/file not found/);
      expect(fake.createCalls).toBe(2);
      const seal = fake.commands.filter((command) => command.includes("killall") && command.includes("browser.sock"));
      expect(seal.length).toBeGreaterThan(0);
      expect(fake.commands.some((command) => /\bgoogle-chrome\b/.test(command) && !command.includes("killall"))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("approves, denies, and cancels through the app server", async () => {
    const { harness, port, cleanup } = await open({
      streamFn: scriptedReply((messages) => {
        const lastUser = messages.reduce((found, message, index) => (message.role === "user" ? index : found), -1);
        const ran = messages.slice(lastUser + 1).some((message) => message.role === "toolResult");
        if (!ran) return { calls: [{ name: "fs_delete", arguments: { path: "note.txt" } }] };
        return { text: "deleted note.txt sk-abcdefghijklmnop" };
      }),
    });
    try {
      const client = new LincoClient(`http://127.0.0.1:${port}`);
      const ada = await client.openAppSession("weblinco:approve");
      const user = harness.db.getUser(ada.userId);
      const note = path.join(user?.workspacePath ?? "", "note.txt");
      fs.writeFileSync(note, "keep");
      const waiting = await client.sendAppMessage("weblinco:approve", "Delete note.txt", 5_000);
      expect(waiting.task.status).toBe("waiting_approval");
      const approvalId = waiting.approvals.find((item) => item.status === "pending")?.id ?? "";
      const denied = await client.sendAppMessage("weblinco:deny", "Delete note.txt", 5_000);
      expect(denied.task.status).toBe("waiting_approval");
      const deniedId = denied.approvals.find((item) => item.status === "pending")?.id ?? "";
      await client.approveApp(denied.task.id, deniedId, "denied");
      const denial = await client.appTask(denied.task.id);
      expect(denial.task.status).toBe("failed");
      const resumed = await client.approveApp(waiting.task.id, approvalId, "approved");
      expect(resumed.status).toBe("queued");
      const done = await client.watch(waiting.task.id, { app: true });
      expect(done.task.status).toBe("succeeded");
      expect(JSON.stringify(done)).not.toContain("sk-abcdefghijklmnop");
      expect(JSON.stringify(done)).toContain("sk-[redacted]");
      expect(fs.existsSync(note)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("cancels a queued app task and recovers one after the worker stops", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-app-life-"));
    const quiet = new Harness({
      config: loadConfig({ dataDir, skillsDir, workerCount: 0, schedulerIntervalMs: 60_000, port: 0, authMode: "dev", host: "127.0.0.1" }),
      model: SCRIPT_MODEL,
      streamFn: scriptedStream([{ text: "should not run" }]),
    });
    quiet.start();
    const server = new HarnessServer(quiet);
    const port = await server.listen(0, "127.0.0.1");
    try {
      const client = new LincoClient(`http://127.0.0.1:${port}`);
      const queued = await client.sendAppMessage("weblinco:cancel", "Say hello");
      expect(queued.task.status).toBe("queued");
      const cancelled = await client.cancelApp(queued.task.id);
      expect(cancelled.status).toBe("cancelled");
      const viewed = await client.appTask(queued.task.id);
      expect(viewed.task.status).toBe("cancelled");
      expect(viewed.evidence.runs).toEqual([]);
    } finally {
      await server.close();
      await quiet.stop();
    }
    const first = new Harness({
      config: loadConfig({ dataDir, skillsDir, workerCount: 0, schedulerIntervalMs: 60_000, port: 0, authMode: "dev", host: "127.0.0.1" }),
      model: SCRIPT_MODEL,
      streamFn: scriptedStream([{ text: "recovered" }]),
    });
    first.start();
    const opened = first.openAppSession("weblinco:restart");
    const task = await first.submit(opened.sessionId, "Say hello");
    expect(first.db.claimTask("dead-worker", 1)?.status).toBe("running");
    await sleep(30);
    await first.stop();
    const second = new Harness({
      config: loadConfig({ dataDir, skillsDir, workerCount: 1, schedulerIntervalMs: 40, leaseMs: 5_000, heartbeatMs: 200, port: 0, authMode: "dev", host: "127.0.0.1" }),
      model: SCRIPT_MODEL,
      streamFn: scriptedStream([{ text: "recovered" }]),
    });
    second.start();
    try {
      const done = await second.waitForTask(task.id, 5_000);
      expect(done.status).toBe("succeeded");
      expect(done.resultText).toContain("recovered");
    } finally {
      await second.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses a user token on the app route and on another user's task", async () => {
    const { port, cleanup } = await open({
      authMode: "token",
      bootstrapToken: "pilot-bootstrap",
      streamFn: scriptedStream([{ text: "hello" }]),
    });
    try {
      const app = new LincoClient(`http://127.0.0.1:${port}`, "pilot-bootstrap");
      const created = await app.createUser("Bea");
      const sent = await app.sendAppMessage("weblinco:ada", "Say hello", 5_000);
      expect(sent.task.status).toBe("succeeded");
      expect(credentialFree(sent)).toBe(true);
      expect(sent).not.toHaveProperty("token");
      const user = new LincoClient(`http://127.0.0.1:${port}`, created.token);
      await expect(user.sendAppMessage("weblinco:ada", "Say hello", 1_000)).rejects.toThrow(/403/);
      await expect(user.task(sent.task.id)).rejects.toThrow(/404/);
      await expect(app.task(sent.task.id)).rejects.toThrow(/403/);
    } finally {
      await cleanup();
    }
  });
});

async function open(input: {
  streamFn: StreamFn;
  authMode?: "dev" | "token";
  bootstrapToken?: string;
  boat?: (db: LincoDb) => BoatSandboxManager;
}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-app-"));
  const harness = new Harness({
    config: loadConfig({
      dataDir,
      skillsDir,
      workerCount: 1,
      schedulerIntervalMs: 40,
      port: 0,
      authMode: input.authMode ?? "dev",
      bootstrapToken: input.bootstrapToken,
      host: "127.0.0.1",
      vmBrowser: false,
    }),
    model: SCRIPT_MODEL,
    streamFn: input.streamFn,
    ...(input.boat ? { boat: input.boat } : {}),
  });
  harness.start();
  const server = new HarnessServer(harness);
  const port = await server.listen(0, "127.0.0.1");
  return {
    harness,
    port,
    cleanup: async () => {
      await server.close();
      await harness.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function credentialFree(value: unknown): boolean {
  const text = JSON.stringify(value);
  return !text.includes("pilot-bootstrap") && !/sk-[A-Za-z0-9]{8,}/.test(text) && !text.includes("Bearer ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

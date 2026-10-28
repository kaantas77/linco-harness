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
import { SCRIPT_MODEL, scriptedReply, scriptedStream, zeroUsage } from "../src/llm/scripted.js";
import { HarnessServer } from "../src/server/http.js";
import { FakeBoat } from "./boat-fake.js";

const skillsDir = path.resolve("skills");

describe("backend api", () => {
  it("queues a message, returns evidence, and keeps the next task in the same session", async () => {
    let turn = 0;
    const { harness, port, cleanup } = await open({
      streamFn: scriptedReply(() => {
        turn += 1;
        if (turn === 1) return { text: "hello", usage: zeroUsage({ input: 4, output: 2, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } }) };
        if (turn === 2) return { calls: [{ name: "fs_write", arguments: { path: "keep.txt", content: "PHASE-KEEP" } }] };
        return { text: "saved PHASE-KEEP" };
      }),
    });
    try {
      const client = new LincoClient(`http://127.0.0.1:${port}`);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(await health.json()).toMatchObject({ ok: true, publicReady: false, vmBrowser: false });
      const user = harness.createUser("Ada");
      const session = harness.createSession(user.id);
      const queued = await client.sendMessage(session.id, "Say hello");
      expect(queued.status).toBe("queued");
      const done = await client.wait(queued.id);
      expect(done.task.status).toBe("succeeded");
      expect(done.evidence.contract).toBeNull();
      expect(done.usage.costUsd).toBeGreaterThan(0);
      const events = await fetch(`http://127.0.0.1:${port}/v1/tasks/${queued.id}/events`);
      expect(events.headers.get("content-type")).toContain("text/event-stream");
      expect(await events.text()).toContain("succeeded");
      const second = await client.sendMessage(session.id, "Save keep.txt", 5_000);
      expect(second.status).toBe("succeeded");
      expect(fs.readFileSync(path.join(user.workspacePath, "keep.txt"), "utf8")).toBe("PHASE-KEEP");
      const evidence = await client.evidence(second.id);
      expect(evidence.evidence.runs.some((run) => run.name === "fs_write" && !run.isError)).toBe(true);
      const usage = await fetch(`http://127.0.0.1:${port}/v1/users/${user.id}/usage`);
      const usageBody = (await usage.json()) as { limits: { activeVmPerUser: number } };
      expect(usageBody.limits.activeVmPerUser).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("lets the user approve, deny, or cancel, and hides a secret from the task view", async () => {
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
      const user = harness.createUser("Ada");
      const session = harness.createSession(user.id);
      fs.writeFileSync(path.join(user.workspacePath, "note.txt"), "keep");
      const waiting = await client.sendMessage(session.id, "Delete note.txt", 5_000);
      expect(waiting.status).toBe("waiting_approval");
      const approvalId = harness.db.listApprovals(waiting.id)[0]?.id ?? "";
      const resumed = await client.approve(waiting.id, approvalId, "approved");
      expect(resumed.status).toBe("queued");
      const done = await client.wait(waiting.id);
      expect(done.task.status).toBe("succeeded");
      expect(JSON.stringify(done)).not.toContain("sk-abcdefghijklmnop");
      expect(JSON.stringify(done)).toContain("sk-[redacted]");
      expect(fs.existsSync(path.join(user.workspacePath, "note.txt"))).toBe(false);

      const denied = await client.sendMessage(session.id, "Delete note.txt", 5_000);
      expect(denied.status).toBe("waiting_approval");
      fs.writeFileSync(path.join(user.workspacePath, "note.txt"), "keep");
      const deniedApproval = harness.db.listApprovals(denied.id).find((item) => item.status === "pending");
      const failed = await client.approve(denied.id, deniedApproval?.id ?? "", "denied");
      expect(failed.status).toBe("failed");

      const parked = await client.sendMessage(session.id, "Delete note.txt", 5_000);
      expect(parked.status).toBe("waiting_approval");
      const controller = new AbortController();
      const stream = fetch(`http://127.0.0.1:${port}/v1/tasks/${parked.id}/events`, { signal: controller.signal });
      await sleep(50);
      controller.abort();
      await stream.catch(() => undefined);
      const cancelled = await client.cancel(parked.id);
      expect(cancelled.status).toBe("cancelled");
      expect(fs.readFileSync(path.join(user.workspacePath, "note.txt"), "utf8")).toBe("keep");
    } finally {
      await cleanup();
    }
  });

  it("stops a task that crosses the cost ceiling", async () => {
    const { port, cleanup } = await open({
      taskMaxCostUsd: 0,
      streamFn: scriptedStream([{ text: "hello", usage: zeroUsage({ cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 1 } }) }]),
    });
    try {
      const client = new LincoClient(`http://127.0.0.1:${port}`);
      const user = await client.createUser("Ada");
      const session = await client.createSession(user.id);
      const task = await client.sendMessage(session.id, "Say hello", 5_000);
      expect(task.status).toBe("failed");
      expect(task.error).toMatch(/budget exceeded/);
    } finally {
      await cleanup();
    }
  });

  it("recovers a task after the worker process is gone", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-restart-"));
    const first = new Harness({
      config: loadConfig({ dataDir, skillsDir, workerCount: 0, schedulerIntervalMs: 60_000, port: 0, authMode: "dev" }),
      model: SCRIPT_MODEL,
      streamFn: scriptedStream([{ text: "recovered" }]),
    });
    first.start();
    const user = first.createUser("Ada");
    const session = first.createSession(user.id);
    const queued = await first.submit(session.id, "Say hello");
    const claimed = first.db.claimTask("dead-worker", 1);
    expect(claimed?.status).toBe("running");
    await sleep(30);
    await first.stop();
    const second = new Harness({
      config: loadConfig({ dataDir, skillsDir, workerCount: 1, schedulerIntervalMs: 40, leaseMs: 5_000, heartbeatMs: 200, port: 0, authMode: "dev" }),
      model: SCRIPT_MODEL,
      streamFn: scriptedStream([{ text: "recovered" }]),
    });
    second.start();
    try {
      const done = await second.waitForTask(queued.id, 5_000);
      expect(done.status).toBe("succeeded");
      expect(done.resultText).toContain("recovered");
    } finally {
      await second.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses another user the session, the task, and the Boat files", async () => {
    const fake = new FakeBoat();
    let manager!: BoatSandboxManager;
    let turn = 0;
    const { harness, port, cleanup } = await open({
      authMode: "token",
      bootstrapToken: "pilot-bootstrap",
      streamFn: scriptedReply(() => {
        turn += 1;
        if (turn === 1) return { calls: [{ name: "fs_write", arguments: { path: "keep.txt", content: "PHASE-KEEP" } }] };
        if (turn === 2) return { text: "saved" };
        if (turn === 3) return { calls: [{ name: "fs_read", arguments: { path: "keep.txt" } }] };
        return { text: "done" };
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
      const root = new LincoClient(`http://127.0.0.1:${port}`, "pilot-bootstrap");
      const ada = await root.createUser("Ada");
      const bea = await root.createUser("Bea");
      const adaClient = new LincoClient(`http://127.0.0.1:${port}`, ada.token);
      const beaClient = new LincoClient(`http://127.0.0.1:${port}`, bea.token);
      const session = await adaClient.createSession(ada.id);
      const saved = await adaClient.sendMessage(session.id, "Write keep.txt", 5_000);
      expect(saved.status).toBe("succeeded");
      expect((await manager.read(ada.id, "keep.txt")).text).toBe("PHASE-KEEP");
      const again = await adaClient.sendMessage(session.id, "Read keep.txt", 5_000);
      expect(again.status).toBe("succeeded");
      expect(fake.createCalls).toBe(1);
      const names = harness.db.listTraces(saved.id).flatMap((trace) => {
        const data = trace.data as { names?: string[] };
        return data.names ?? [];
      });
      expect(names).not.toContain("vm_browser_goto");
      await expect(manager.browserAct(ada.id, saved.id, { op: "read" })).rejects.toThrow(/private pilot/);
      await expect(beaClient.sendMessage(session.id, "Read keep.txt", 1_000)).rejects.toThrow(/404/);
      await expect(beaClient.task(saved.id)).rejects.toThrow(/404/);
      await expect(beaClient.computer(ada.id)).rejects.toThrow(/404/);
      const beaSession = await beaClient.createSession(bea.id);
      await beaClient.sendMessage(beaSession.id, "Read keep.txt", 5_000);
      await expect(manager.read(bea.id, "keep.txt")).rejects.toThrow(/file not found/);
      expect(fake.createCalls).toBe(2);
    } finally {
      await cleanup();
    }
  });
});

async function open(input: {
  streamFn: StreamFn;
  authMode?: "dev" | "token";
  bootstrapToken?: string;
  taskMaxCostUsd?: number;
  boat?: (db: LincoDb) => BoatSandboxManager;
}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-api-"));
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
      taskMaxCostUsd: input.taskMaxCostUsd,
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
    server,
    port,
    cleanup: async () => {
      await server.close();
      await harness.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

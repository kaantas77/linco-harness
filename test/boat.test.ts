import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Harness } from "../src/agent/runtime.js";
import { mcpCommand } from "../src/boat/mcp.js";
import { BoatSandboxManager } from "../src/boat/manager.js";
import { modelAcceptsImages } from "../src/boat/vision.js";
import { loadConfig } from "../src/config.js";
import { LincoDb } from "../src/db/database.js";
import { createDeepSeek } from "../src/llm/deepseek.js";
import { SCRIPT_MODEL, scriptedReply } from "../src/llm/scripted.js";
import { HarnessServer } from "../src/server/http.js";
import { desktopTools } from "../src/tools/desktop-tools.js";
import type { ToolHost } from "../src/tools/host.js";
import { FakeBoat } from "./boat-fake.js";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");
const reports = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../reports");
const cases: Array<{ id: string; ok: boolean; detail: string }> = [];

afterAll(() => {
  const live = process.env.LINCO_BOAT_LIVE === "1" && Boolean(process.env.BOAT_API_KEY);
  const report = {
    createdAt: new Date().toISOString(),
    mode: "offline",
    performanceClaim: "none",
    liveExecuted: false,
    liveReason: live ? "live run is a separate command and was not folded into this file" : "BOAT_API_KEY was not used; LINCO_BOAT_LIVE is off",
    cases,
  };
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, "boat.json"), `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    "# Linco on Boat",
    "",
    "Mode: offline. Performance claim: none. This is not a ranking.",
    "",
    "The fake API follows Boat's documented disk rule: `/home/user` survives stop and resume, `/tmp` does not, and a stopped disk is kept for 14 days.",
    "No live sandbox was created by this file.",
    "",
    "| case | ok | detail |",
    "| --- | --- | --- |",
    ...cases.map((row) => `| ${row.id} | ${row.ok ? "yes" : "no"} | ${row.detail} |`),
    "",
  ];
  fs.writeFileSync(path.join(reports, "boat.md"), lines.join("\n"));
});

describe("boat computer", () => {
  it("keeps one sandbox per user and the home file across stop and resume", async () => {
    const { db, manager, fake, root, cleanup } = open();
    fake.delayMs = 40;
    try {
      const ada = db.createUser("Ada", root);
      const bea = db.createUser("Bea", root);
      const [first, second] = await Promise.all([manager.ensure(ada.id), manager.ensure(ada.id)]);
      expect(first.sandboxId).toBe(second.sandboxId);
      expect(fake.createCalls).toBe(1);
      const other = await manager.ensure(bea.id);
      expect(other.sandboxId).not.toBe(first.sandboxId);
      await manager.write(ada.id, "note.txt", "kept");
      await manager.run(ada.id, "printf gone > /tmp/ephemeral.txt", 5_000);
      expect(fake.tmp(first.sandboxId ?? "", "/tmp/ephemeral.txt")).toBe("gone");
      const stopped = await manager.stop(ada.id);
      expect(stopped.status).toBe("stopped");
      expect(fake.tmp(first.sandboxId ?? "", "/tmp/ephemeral.txt")).toBeUndefined();
      const text = await manager.read(ada.id, "note.txt");
      expect(text.text).toBe("kept");
      await expect(manager.read(bea.id, "note.txt")).rejects.toThrow(/file not found/);
      const described = await manager.describe(ada.id);
      expect(described.retentionNote).toMatch(/14 days/);
      expect(described.snapshotStatus).toBe("completed");
      expect(JSON.stringify(described)).not.toMatch(/boat_[A-Za-z0-9]|on\.boat\.dev|_token=/);
      record("persist", true, "one sandbox per user; home file survived; /tmp did not; the other user cannot read it");
    } finally {
      cleanup();
    }
  });

  it("rejects a stale snapshot, a usage cap, a foreign mount, and an unlocked second desktop", async () => {
    const { db, manager, fake, root, cleanup } = open();
    try {
      const ada = db.createUser("Ada", root);
      const ready = await manager.ensure(ada.id);
      await manager.stop(ada.id);
      fake.expire(ready.sandboxId ?? "");
      await expect(manager.read(ada.id, "note.txt")).rejects.toThrow(/expired/);
      const fresh = open();
      const user = fresh.db.createUser("Ada", fresh.root);
      await fresh.manager.ensure(user.id);
      await expect(fresh.manager.fetchPage(user.id, "http://169.254.169.254/latest")).rejects.toThrow(/blocked/);
      expect(fresh.fake.commands.some((command) => command.includes("169.254.169.254"))).toBe(false);
      await expect(fresh.manager.fetchPage(user.id, "http://evil.test/hop")).rejects.toThrow(/blocked/);
      expect(fresh.fake.commands.some((command) => command.includes("--resolve") && command.includes("1.1.1.1"))).toBe(true);
      const echoed = await fresh.manager.run(user.id, "echo boat_secret", 5_000);
      expect(echoed.stdout).not.toContain("boat_secret");
      expect(echoed.stdout).not.toContain("_token=");
      fresh.fake.desktopDelayMs = 80;
      const settled = await Promise.allSettled([
        fresh.manager.desktop(user.id, "task-a", "get_desktop_state", {}),
        fresh.manager.desktop(user.id, "task-b", "get_desktop_state", {}),
      ]);
      expect(settled.filter((item) => item.status === "rejected").map((item) => (item as PromiseRejectedResult).reason.message).join(" ")).toMatch(/desktop is in use/);
      fresh.fake.usageSeconds = 9_000;
      await expect(fresh.manager.run(user.id, "printf hi > note.txt", 5_000)).rejects.toThrow(/usage limit/);
      const idle = await fresh.manager.reapIdle(new Date(Date.now() + 60_000));
      expect(idle).toBe(0);
      fresh.db.saveComputer(user.id, { status: "ready", touch: false });
      const stopped = await fresh.manager.reapIdle(new Date(Date.now() + 60_000));
      expect(stopped).toBe(1);
      record("limits", true, "expired disk, usage cap, metadata redirect, secret redaction, desktop lock, and idle stop");
      fresh.cleanup();
    } finally {
      cleanup();
    }
  });

  it("runs a task on the remote computer and leaves the host workspace unchanged", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-boat-host-"));
    const db = new LincoDb(path.join(dataDir, "linco.sqlite"));
    const fake = new FakeBoat();
    const manager = managerFor(db, fake);
    let turn = 0;
    const harness = new Harness({
      config: loadConfig({
        dataDir,
        skillsDir,
        workerCount: 1,
        schedulerIntervalMs: 60_000,
        port: 0,
        authMode: "dev",
        manageCredentials: false,
        sandbox: "off",
        computer: "boat",
      }),
      model: SCRIPT_MODEL,
      streamFn: scriptedReply(() => {
        turn += 1;
        if (turn === 1) return { calls: [{ name: "fs_write", arguments: { path: "note.txt", content: "kept" } }] };
        if (turn === 2) return { calls: [{ name: "shell_exec", arguments: { command: "printf fromshell > shell.txt" } }] };
        return { text: "done" };
      }),
      boat: manager,
    });
    harness.start();
    try {
      const user = harness.createUser("Ada");
      const session = harness.createSession(user.id);
      expect(session.systemPrompt).toContain("linco-computer: boat");
      const task = await harness.submit(session.id, "Write the note on the Boat computer.", { waitMs: 8_000 });
      expect(task.status, task.error ?? "").toBe("succeeded");
      expect((await manager.read(user.id, "note.txt")).text).toBe("kept");
      expect((await manager.read(user.id, "shell.txt")).text).toBe("fromshell");
      expect(fs.readdirSync(user.workspacePath)).not.toContain("note.txt");
      expect(fs.readdirSync(user.workspacePath)).not.toContain("shell.txt");
      expect(fake.createCalls).toBe(1);
      record("task", true, "one task wrote and read on the sandbox; the host workspace did not change");
    } finally {
      await harness.stop();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("asks before desktop input and hides images from a text-only model", async () => {
    const fake = new FakeBoat();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-boat-click-"));
    const db = new LincoDb(path.join(dataDir, "linco.sqlite"));
    const manager = managerFor(db, fake);
    let turn = 0;
    const harness = new Harness({
      config: loadConfig({
        dataDir,
        skillsDir,
        workerCount: 1,
        schedulerIntervalMs: 60_000,
        port: 0,
        authMode: "dev",
        manageCredentials: false,
        sandbox: "off",
        computer: "boat",
      }),
      model: SCRIPT_MODEL,
      streamFn: scriptedReply(() => {
        turn += 1;
        if (turn < 3) return { calls: [{ name: "desktop_click", arguments: { x: 4, y: 8 } }] };
        return { text: "clicked" };
      }),
      boat: manager,
    });
    harness.start();
    try {
      const user = harness.createUser("Ada");
      const session = harness.createSession(user.id);
      const waiting = await harness.submit(session.id, "Click the button.", { waitMs: 8_000 });
      expect(waiting.status).toBe("waiting_approval");
      expect(fake.desktopCalls).toHaveLength(0);
      const approval = harness.db.listApprovals(waiting.id)[0];
      harness.approve(waiting.id, approval?.id ?? "", "approved");
      const done = await harness.waitForTask(waiting.id, 8_000);
      expect(done.status).toBe("succeeded");
      expect(fake.desktopCalls.some((call) => call.tool === "click")).toBe(true);
      const blind = desktopTools({ desktop: { acceptsImages: false, call: async () => ({ text: "window Chrome", tree: "window Chrome", image: { data: "SECRET", mimeType: "image/png" } }) } } as ToolHost);
      const shot = blind.find((tool) => tool.name === "desktop_screenshot");
      const hidden = await shot?.execute("1", {}, new AbortController().signal);
      expect(JSON.stringify(hidden)).not.toContain("SECRET");
      expect(JSON.stringify(hidden)).toContain("model input does not include images");
      const sighted = desktopTools({ desktop: { acceptsImages: true, call: async () => ({ text: "window Chrome", tree: "window Chrome", image: { data: "SECRET", mimeType: "image/png" } }) } } as ToolHost);
      const shown = await sighted.find((tool) => tool.name === "desktop_screenshot")?.execute("1", {}, new AbortController().signal);
      expect(JSON.stringify(shown)).toContain("SECRET");
      expect(modelAcceptsImages(createDeepSeek("deepseek-flash").model)).toBe(true);
      expect(modelAcceptsImages(createDeepSeek("deepseek-v4-pro").model)).toBe(false);
      expect(modelAcceptsImages(SCRIPT_MODEL)).toBe(false);
      const page = await manager.desktop(user.id, waiting.id, "get_browser_state", {});
      expect(page.tree).toContain("Example Domain");
      const command = mcpCommand("get_desktop_state", {});
      const encoded = command.split(" ")[2] ?? "";
      const script = Buffer.from(encoded, "base64").toString("utf8");
      expect(script).toContain("/opt/ascii/cua-driver/cua-driver");
      expect(script).toContain("--socket");
      expect(script).toContain("/run/ascii-cua/driver.sock");
      expect(script).toContain("isError");
      expect(script).not.toContain("npm install");
      expect(command).not.toContain("boat_");
      record("desktop", true, "click waits for approval; text-only models receive the tree; Flash accepts images and Pro does not");
    } finally {
      await harness.stop();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("hides another user's computer from the API", async () => {
    const fake = new FakeBoat();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-boat-http-"));
    const db = new LincoDb(path.join(dataDir, "linco.sqlite"));
    const manager = managerFor(db, fake);
    const harness = new Harness({
      config: loadConfig({
        dataDir,
        skillsDir,
        workerCount: 0,
        schedulerIntervalMs: 60_000,
        port: 0,
        authMode: "token",
        bootstrapToken: "bootstrap-test",
        manageCredentials: true,
        computer: "boat",
      }),
      boat: manager,
    });
    const server = new HarnessServer(harness);
    const port = await server.listen(0, "127.0.0.1");
    try {
      const created = await call(port, "POST", "/v1/users", { name: "Ada" }, "bootstrap-test");
      const ada = (await created.json()) as { id: string; token: string };
      const beaResponse = await call(port, "POST", "/v1/users", { name: "Bea" }, "bootstrap-test");
      const bea = (await beaResponse.json()) as { id: string; token: string };
      const hidden = await call(port, "GET", `/v1/users/${bea.id}/computer`, undefined, ada.token);
      expect(hidden.status).toBe(404);
      const opened = await call(port, "POST", `/v1/users/${ada.id}/computer`, {}, ada.token);
      expect(opened.status).toBe(201);
      const body = JSON.stringify(await opened.json());
      expect(body).not.toMatch(/boat_[A-Za-z0-9]|on\.boat\.dev|_token=/);
      expect(body).toContain("sbx_");
      const own = await call(port, "GET", `/v1/users/${ada.id}/computer`, undefined, ada.token);
      expect(own.status).toBe(200);
      record("auth", true, "another user's computer route is 404 and the payload has no Boat credential");
    } finally {
      await server.close();
      await harness.stop();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

function open() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-boat-"));
  const db = new LincoDb(path.join(root, "linco.sqlite"));
  const fake = new FakeBoat();
  return {
    root,
    db,
    fake,
    manager: managerFor(db, fake),
    cleanup: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function managerFor(db: LincoDb, fake: FakeBoat): BoatSandboxManager {
  return new BoatSandboxManager({
    client: fake,
    db,
    machineType: "small",
    ttlSeconds: 600,
    idleStopMs: 1_000,
    maxSeconds: 7_200,
    readyTimeoutMs: 2_000,
    lookup: async (host) => [{ address: host === "evil.test" ? "1.1.1.1" : "93.184.216.34" }],
  });
}

function call(port: number, method: string, pathname: string, body?: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

function record(id: string, ok: boolean, detail: string): void {
  cases.push({ id, ok, detail });
}

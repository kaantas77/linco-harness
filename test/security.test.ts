import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createGoal } from "../src/agent/goal.js";
import { Harness } from "../src/agent/runtime.js";
import { inspectDestination } from "../src/browser/navigation-policy.js";
import { loadConfig } from "../src/config.js";
import { SCRIPT_MODEL, scriptedReply } from "../src/llm/scripted.js";
import { bwrapArgs, sandboxBackend } from "../src/security/isolate.js";
import { HarnessServer } from "../src/server/http.js";
import { HttpBrowserProvider } from "../src/tools/http-browser.js";
import { LocalComputerProvider } from "../src/tools/local-computer.js";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = path.join(repo, "node_modules/vite-node/vite-node.mjs");
const worker = path.join(repo, "test/worker-proc.ts");
const reports = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../reports");

const cases: Array<{ id: string; ok: boolean; detail: string }> = [];

afterAll(() => {
  const report = {
    createdAt: new Date().toISOString(),
    mode: "offline",
    performanceClaim: "none",
    sandbox: sandboxBackend(),
    cases,
  };
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, "security.json"), `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    "# Linco security",
    "",
    "Mode: offline. Performance claim: none.",
    "",
    `Sandbox backend: ${report.sandbox ?? "none"}.`,
    "",
    "| case | ok | detail |",
    "| --- | --- | --- |",
    ...cases.map((row) => `| ${row.id} | ${row.ok ? "yes" : "no"} | ${row.detail} |`),
    "",
    "## Notes",
    "",
    "- Token auth is the default. `LINCO_AUTH=dev` is the open loopback mode.",
    "- Loopback URLs stay closed unless `LINCO_ALLOW_LOOPBACK=1`.",
    "- The OS sandbox refuses the command when seatbelt or bubblewrap is missing.",
    "- Exactly-once is not claimed. A file written before the fence check is not rolled back.",
    "- Darwin does not get a reliable address-space cap from ulimit. CPU seconds, process count, file size, and wall clock are the limits that are applied.",
    "- Webhook URLs remain a secret capability. They are not a user session.",
    "",
  ];
  fs.writeFileSync(path.join(reports, "security.md"), lines.join("\n"));
});

describe("http auth", () => {
  it("rejects anonymous calls and hides another user's task", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-auth-"));
    const harness = new Harness({
      config: loadConfig({
        dataDir,
        skillsDir,
        workerCount: 1,
        schedulerIntervalMs: 60_000,
        port: 0,
        authMode: "token",
        bootstrapToken: "bootstrap-test",
        allowLoopback: false,
        sandbox: "require",
      }),
      model: SCRIPT_MODEL,
      streamFn: scriptedReply(() => ({ text: "done" })),
    });
    harness.start();
    const server = new HarnessServer(harness);
    const port = await server.listen(0, "127.0.0.1");
    try {
      expect((await call(port, "GET", "/health")).status).toBe(200);
      expect((await call(port, "POST", "/v1/users", { name: "Ada" })).status).toBe(401);
      expect((await call(port, "GET", "/v1/skills", undefined, "bootstrap-test")).status).toBe(403);
      const created = await call(port, "POST", "/v1/users", { name: "Ada" }, "bootstrap-test");
      expect(created.status).toBe(201);
      const ada = (await created.json()) as { id: string; token: string };
      const other = await call(port, "POST", "/v1/users", { name: "Bea" }, "bootstrap-test");
      const bea = (await other.json()) as { id: string; token: string };
      const adaSession = await call(port, "POST", "/v1/sessions", { userId: ada.id }, ada.token);
      const beaSession = await call(port, "POST", "/v1/sessions", { userId: bea.id }, bea.token);
      const adaBody = (await adaSession.json()) as { id: string };
      const beaBody = (await beaSession.json()) as { id: string };
      const posted = await call(port, "POST", `/v1/sessions/${beaBody.id}/messages`, { text: "hello", waitMs: 4_000 }, bea.token);
      const task = (await posted.json()) as { id: string; status: string };
      expect(task.status).toBe("succeeded");
      expect((await call(port, "GET", `/v1/tasks/${task.id}`, undefined, ada.token)).status).toBe(404);
      expect((await call(port, "POST", `/v1/tasks/${task.id}/cancel`, {}, ada.token)).status).toBe(404);
      expect((await call(port, "POST", `/v1/tasks/${task.id}/approve`, { decision: "approved", approvalId: "missing" }, ada.token)).status).toBe(404);
      expect((await call(port, "GET", `/v1/tasks/${task.id}/observe`, undefined, ada.token)).status).toBe(404);
      expect((await call(port, "GET", `/v1/sessions/${beaBody.id}`, undefined, ada.token)).status).toBe(404);
      expect((await call(port, "POST", `/v1/users/${bea.id}/memories`, { title: "x", body: "y" }, ada.token)).status).toBe(404);
      expect((await call(port, "POST", "/v1/sessions", { userId: bea.id }, ada.token)).status).toBe(404);
      expect((await call(port, "GET", `/v1/sessions/${adaBody.id}`, undefined, ada.token)).status).toBe(200);
      record("auth", true, "anonymous 401, cross-user task cancel approve and memory 404");
    } finally {
      await server.close();
      await harness.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses dev auth on a public bind", () => {
    expect(
      () =>
        new Harness({
          config: loadConfig({
            dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "linco-dev-")),
            skillsDir,
            host: "0.0.0.0",
            authMode: "dev",
            workerCount: 0,
            port: 0,
          }),
        }),
    ).toThrow(/loopback/);
    record("dev-bind", true, "LINCO_AUTH=dev refuses 0.0.0.0");
  });
});

describe("network", () => {
  it("blocks private targets, rebinding, and redirects", async () => {
    await expect(inspectDestination("http://evil.test", { lookup: async () => [{ address: "10.0.0.8" }] })).rejects.toThrow(/blocked/);
    await expect(inspectDestination("http://127.0.0.1/")).rejects.toThrow(/blocked/);
    const site = await listen((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/hop") {
        response.writeHead(302, { location: "http://169.254.169.254/latest" });
        response.end();
        return;
      }
      response.end("public-ok");
    });
    try {
      const browser = new HttpBrowserProvider({ allowLoopback: true });
      await expect(browser.fetchPage(`${site.url}hop`)).rejects.toThrow(/blocked/);
      const closed = new HttpBrowserProvider({ allowLoopback: false });
      await expect(closed.fetchPage(site.url)).rejects.toThrow(/blocked/);
      const page = await browser.fetchPage(site.url);
      expect(page.text).toContain("public-ok");
      record("ssrf", true, "private DNS, loopback default, and metadata redirect blocked");
    } finally {
      await site.close();
    }
  });
});

describe("sandbox", () => {
  it("keeps shell and code inside the workspace", async () => {
    expect(bwrapArgs("/tmp/linco-workspace").join(" ")).toContain("--unshare-all");
    const backend = sandboxBackend();
    expect(backend).toBeTruthy();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-box-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "linco-other-"));
    fs.writeFileSync(path.join(other, "secret.txt"), "hidden");
    const computer = new LocalComputerProvider("require");
    try {
      const wrote = await computer.exec({ command: "printf inside > note.txt", cwd: root, timeoutMs: 5_000 });
      expect(wrote.exitCode).toBe(0);
      expect(fs.readFileSync(path.join(root, "note.txt"), "utf8")).toBe("inside");
      const passwd = await computer.exec({
        command: `node -e "process.stdout.write(require('fs').readFileSync('/'+'etc/passwd','utf8'))"`,
        cwd: root,
        timeoutMs: 5_000,
      });
      expect(passwd.exitCode).not.toBe(0);
      expect(passwd.stdout).not.toContain("root:");
      const stolen = await computer.exec({
        command: `node -e "process.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(other, "secret.txt"))},'utf8'))"`,
        cwd: root,
        timeoutMs: 5_000,
      });
      expect(stolen.stdout).not.toContain("hidden");
      expect(fs.readFileSync(path.join(other, "secret.txt"), "utf8")).toBe("hidden");
      const network = await computer.exec({
        command: `node -e "fetch('http://127.0.0.1:9').then(()=>process.exit(0)).catch(()=>process.exit(2))"`,
        cwd: root,
        timeoutMs: 5_000,
      });
      expect(network.exitCode).not.toBe(0);
      const mounts = await computer.exec({
        command: `node -e "const fs=require('fs'); function code(p){try{fs.readdirSync(p); return 'ok'}catch(e){return e.code||'err'}}; process.stdout.write([code('/Volumes'), code('/opt'), code('/mnt')].join(' '))"` ,
        cwd: root,
        timeoutMs: 5_000,
      });
      expect(mounts.stdout).toContain("EPERM");
      expect(mounts.stdout).not.toContain("ok");
      const wrapped = bwrapArgs(root).join(" ");
      expect(wrapped).not.toContain("/opt");
      expect(wrapped).not.toContain("/Volumes");
      expect(wrapped).not.toContain("/mnt");
      record("sandbox", true, `${backend} blocked passwd, the other workspace, loopback fetch, and extra mounts`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("stale fence", () => {
  it("rejects an expired worker from a second process", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-fence-"));
    const harness = new Harness({
      config: loadConfig({
        dataDir,
        skillsDir,
        workerCount: 0,
        schedulerIntervalMs: 60_000,
        port: 0,
        authMode: "dev",
        manageCredentials: false,
        sandbox: "off",
      }),
      model: SCRIPT_MODEL,
      streamFn: scriptedReply(() => ({ text: "later" })),
    });
    try {
      const user = harness.createUser("Ada");
      const session = harness.createSession(user.id);
      harness.db.setTranscript(session.id, [{ role: "user", content: "original", timestamp: 1 }] as never, "original");
      const task = harness.db.enqueueTask({ sessionId: session.id, userId: user.id, prompt: "hold" });
      const child = spawn(process.execPath, [vite, worker, dataDir, skillsDir, "fence"], {
        cwd: repo,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output = { stdout: "", stderr: "" };
      child.stdout?.on("data", (chunk: Buffer) => {
        output.stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output.stderr += chunk.toString("utf8");
      });
      await onceExit(child);
      const file = path.join(dataDir, "fence-result.json");
      expect(fs.existsSync(file), output.stderr || output.stdout).toBe(true);
      const result = JSON.parse(fs.readFileSync(file, "utf8")) as {
        goalOk: boolean;
        planOk: boolean;
        transcript: boolean;
        children: number;
        goal: string | null;
      };
      expect(result.goalOk).toBe(false);
      expect(result.planOk).toBe(false);
      expect(result.transcript).toBe(false);
      expect(result.children).toBe(0);
      expect(result.goal).toBeNull();
      const live = harness.db.getTask(task.id);
      expect(live?.workerId).toBeTruthy();
      const claim = { taskId: task.id, fence: live?.fence ?? 0, workerId: live?.workerId ?? "" };
      const goal = createGoal("from-test", [
        {
          id: "a",
          title: "A",
          expectedOutput: "a",
          criteria: [{ id: "c", description: "file", check: { kind: "file_exists", path: "a.txt" } }],
        },
      ]);
      expect(harness.db.setGoal(task.id, goal, claim)).toBe(false);
      expect(harness.db.setPlan(task.id, [{ id: "a", title: "A", status: "pending" }], claim)).toBe(false);
      expect(JSON.stringify(harness.db.getTranscript(session.id))).toContain("original");
      expect(harness.db.holdsLease(task.id, claim.fence, claim.workerId)).toBe(false);
      expect(harness.db.renewLease(task.id, claim.fence, claim.workerId, 15_000)).toBe(false);
      record("fence", true, "expired lease blocked goal, plan, child, transcript, and renew from both processes");
    } finally {
      await harness.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});

function record(id: string, ok: boolean, detail: string): void {
  cases.push({ id, ok, detail });
}

async function call(port: number, method: string, pathname: string, body?: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function listen(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

function onceExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Harness } from "../agent/runtime.js";
import { loadConfig } from "../config.js";
import { LincoDb } from "../db/database.js";
import { createDeepSeek } from "../llm/deepseek.js";
import type { Task } from "../types.js";
import { createBoatClient } from "./client.js";
import { LIVE_LIMITS } from "./live-check.js";
import { BoatSandboxManager } from "./manager.js";

interface Row {
  name: string;
  mode: "controlled" | "language" | "security";
  category: string;
  ok: boolean;
  status: string;
  evidence: string;
}

export interface ReliabilityReport {
  createdAt: string;
  startedFrom: "8683678";
  mode: "live" | "skipped";
  performanceClaim: "none";
  publicReady: false;
  liveExecuted: boolean;
  liveReason: string;
  sandboxId: string;
  deleted: boolean;
  rows: Row[];
  rates: Record<string, string>;
  blockers: string[];
  totals: { durationMs: number; deepseekUsd: number; boatUsd: number };
  notes: string[];
}

export async function runAgentReliability(input: {
  boatApiKey?: string;
  deepseekApiKey?: string;
  boatBaseUrl?: string;
  reportDir?: string;
  only?: Array<"click" | "desktop" | "form" | "code" | "subagents">;
  stem?: string;
}): Promise<ReliabilityReport> {
  const report = empty();
  const dir = input.reportDir ?? "reports";
  const stem = input.stem ?? "agent-reliability";
  const flush = () => writeReport(report, dir, stem);
  if (!input.boatApiKey || !input.deepseekApiKey) {
    report.liveReason = !input.boatApiKey ? "BOAT_API_KEY is unset" : "DEEPSEEK_API_KEY is unset";
    report.notes.push("No live success is claimed. The Boat VM was not created.");
    flush();
    return report;
  }
  report.mode = "live";
  report.liveExecuted = true;
  report.liveReason = "Railway variables were injected for this process. Values were not written to the report.";
  const started = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-105-"));
  const managerDb = new LincoDb(path.join(root, "linco.sqlite"));
  const client = createBoatClient({ apiKey: input.boatApiKey, basePath: input.boatBaseUrl });
  const manager = new BoatSandboxManager({
    client,
    db: managerDb,
    machineType: LIVE_LIMITS.machineType,
    ttlSeconds: LIVE_LIMITS.ttlSeconds,
    idleStopMs: 60 * 60_000,
    maxSeconds: LIVE_LIMITS.maxSeconds,
    readyTimeoutMs: LIVE_LIMITS.readyTimeoutMs,
  });
  const deepseek = createDeepSeek("deepseek-flash");
  const harness = new Harness({
    config: loadConfig({
      dataDir: root,
      computer: "boat",
      boatApiKey: input.boatApiKey,
      apiKey: input.deepseekApiKey,
      boatBaseUrl: input.boatBaseUrl,
      workerCount: 2,
      maxTurns: 8,
      boatMachineType: LIVE_LIMITS.machineType,
      boatTtlSeconds: LIVE_LIMITS.ttlSeconds,
      boatMaxSeconds: LIVE_LIMITS.maxSeconds,
      boatIdleStopMs: 60 * 60_000,
      manageCredentials: false,
      sandbox: "require",
    }),
    boat: manager,
    model: deepseek.model,
    streamFn: deepseek.streamFn as StreamFn,
    boatReadyTimeoutMs: LIVE_LIMITS.readyTimeoutMs,
  });
  const user = harness.createUser("Reliability");
  const session = harness.createSession(user.id);
  let sandboxId = "";
  let deepseekUsd = 0;
  const boatUsd = async () => (await manager.describe(user.id)).usage?.dollars ?? 0;
  const over = async () => {
    if (Date.now() - started > 15 * 60_000) return "stopped inside the 16 minute subgroup";
    const spent = await boatUsd().catch(() => 0);
    if (spent >= LIVE_LIMITS.boatUsd) return "boat dollar cap";
    if (deepseekUsd >= LIVE_LIMITS.deepseekUsd) return "deepseek dollar cap";
    return "";
  };
  try {
    await manager.ensure(user.id);
    sandboxId = (await manager.describe(user.id)).sandboxId ?? "";
    report.sandboxId = sandboxId;
    const browserWanted = !input.only || input.only.includes("click") || input.only.includes("form");
    if (browserWanted) {
      await securityRows(report, manager, user.id);
      flush();
      const opened = await manager.browserAct(user.id, "controlled-open", { op: "navigate", url: "https://example.com" }).catch((error) => errorText(error));
      report.rows.push({
        name: "controlled open",
        mode: "controlled",
        category: "browser",
        ok: typeof opened !== "string" && (opened.title ?? "") === "Example Domain",
        status: "tool",
        evidence: typeof opened === "string" ? clip(opened) : `title ${opened.title}; url ${opened.url}`,
      });
      flush();
    }
    harness.start();
    const browserUp = !browserWanted || report.rows.some((row) => row.name === "controlled open" && row.ok);
    if (browserWanted && !browserUp) report.notes.push("Browser jobs were skipped because the controlled open did not reach Example Domain.");
    const want = (name: "click" | "desktop" | "form" | "code" | "subagents") => !input.only || input.only.includes(name);
    const buckets = {
      click: [] as Array<() => Promise<number>>,
      desktop: [] as Array<() => Promise<number>>,
      form: [] as Array<() => Promise<number>>,
      code: [] as Array<() => Promise<number>>,
      subagents: [] as Array<() => Promise<number>>,
    };
    if (browserUp && want("click")) {
      for (let index = 1; index <= 10; index += 1) {
        buckets.click.push(() => ask(report, harness, manager, session.id, `click ${index}`, "click", "browser", `example.com sayfasında More information bağlantısına tıkla. Snapshot tek başına yetmez. browser_click kullan.`));
      }
    }
    if (browserUp && want("form")) {
      for (let index = 1; index <= 5; index += 1) {
        buckets.form.push(() => ask(report, harness, manager, session.id, `form ${index}`, "form", "browser", `https://httpbin.org/forms/post formunda müşteri adına PHASE105-FORM-${index} yaz ve gönder.`));
      }
    }
    if (want("desktop")) {
      for (let index = 1; index <= 10; index += 1) {
        const token = `PHASE105-TYPE-${index}`;
        const file = `proof/nl-105-${index}.txt`;
        buckets.desktop.push(() => ask(report, harness, manager, session.id, `desktop ${index}`, "desktop", "desktop", `Masaüstünde nano ile ${file} dosyasına ${token} yaz ve kaydet. Kabuk kullanma.`));
      }
    }
    if (want("code")) {
      for (let index = 1; index <= 5; index += 1) {
        buckets.code.push(() => ask(report, harness, manager, session.id, `code ${index}`, "code", "code", `proof/main-105-${index}.mjs kodunu yaz ve node ile çalıştır. console.log('PHASE105-RUN-${index}')`));
      }
    }
    if (want("subagents")) {
      for (let index = 1; index <= 5; index += 1) {
        buckets.subagents.push(() => ask(report, harness, manager, session.id, `subagents ${index}`, "subagents", "agent", `İki çocuk görev başlat. Biri proof/alpha-105-${index}.txt içine ALPHA-105-${index} yazsın, diğeri proof/beta-105-${index}.txt içine BETA-105-${index} yazsın.`));
      }
    }
    const order = ["click", "desktop", "form", "code", "subagents"] as const;
    let pending = true;
    while (pending) {
      pending = false;
      for (const key of order) {
        const job = buckets[key].shift();
        if (!job) continue;
        pending = true;
        const reason = await over();
        if (reason) {
          report.notes.push(reason);
          pending = false;
          break;
        }
        deepseekUsd += await job();
        flush();
      }
    }
  } catch (error) {
    report.notes.push(`run stopped: ${clip(redact(errorText(error)))}`);
  } finally {
    const spentBoat = await boatUsd().catch(() => 0);
    if (sandboxId) {
      try {
        await manager.stop(user.id);
      } catch (error) {
        report.notes.push(`stop failed: ${clip(redact(errorText(error)))}`);
      }
      try {
        await client.delete(sandboxId);
        report.deleted = true;
      } catch (error) {
        report.deleted = false;
        report.notes.push(`delete failed: ${clip(redact(errorText(error)))}`);
      }
    }
    await harness.stop().catch(() => undefined);
    managerDb.close();
    fs.rmSync(root, { recursive: true, force: true });
    report.totals = { durationMs: Date.now() - started, deepseekUsd: round(deepseekUsd), boatUsd: round(spentBoat) };
    report.rates = rates(report.rows);
    report.notes.push("A row is successful only when the action and an independent read agree. The model status is recorded and is not the proof.");
    report.notes.push("The live runner approves Boat tool calls so the matrix can finish. That approval is not the production user prompt.");
    if (report.blockers.length > 0) report.notes.push("Public use stays NO-GO while a blocker remains.");
    flush();
  }
  return report;
}

async function securityRows(report: ReliabilityReport, manager: BoatSandboxManager, userId: string): Promise<void> {
  const metadata = await manager.browserAct(userId, "sec-meta", { op: "navigate", url: "http://169.254.169.254/latest/meta-data/" }).then(() => "accepted", (error) => errorText(error));
  const metaBlocked = /blocked|private|metadata/i.test(metadata);
  report.rows.push({ name: "metadata url", mode: "security", category: "network", ok: metaBlocked, status: "tool", evidence: clip(metadata) });
  if (!metaBlocked) report.blockers.push("The metadata address was not refused before Chrome opened it.");
  const redirect = await manager.browserAct(userId, "sec-redirect", {
    op: "navigate",
    url: "https://httpbin.org/redirect-to?url=http://169.254.169.254/latest/meta-data/",
  }).then((page) => page.url ?? "accepted", (error) => errorText(error));
  const redirectBlocked = /blocked|private|metadata|403/i.test(redirect) && !redirect.startsWith("http://169.254.169.254");
  const redirectTimedOut = /cdp timeout|timeout/i.test(redirect);
  report.rows.push({ name: "metadata redirect", mode: "security", category: "network", ok: redirectBlocked && !redirectTimedOut, status: "tool", evidence: clip(redirect) });
  if (redirectTimedOut) report.blockers.push("The metadata redirect ended in a timeout. A timeout is not a verified refusal.");
  else if (!redirectBlocked) {
    const stayed = redirect.startsWith("https://httpbin.org/");
    report.blockers.push(stayed
      ? "The redirect left the page on the public redirect URL. The metadata address was not observed, and Chrome did not return an explicit refusal. That is not a verified block."
      : "A public URL that redirects to the metadata address was not refused.");
  }
  const debug = await manager.run(userId, "curl -sS -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:9333/json/version; echo; ss -ltn | grep 9333 || echo 'port 9333 closed'", 15_000).catch((error) => ({ stdout: errorText(error), stderr: "", exitCode: 1 }));
  const portClosed = /port 9333 closed/.test(debug.stdout) && !/200/.test(debug.stdout);
  report.rows.push({ name: "cdp tcp 9333", mode: "security", category: "cdp", ok: portClosed, status: "tool", evidence: clip(debug.stdout || debug.stderr) });
  if (!portClosed) report.blockers.push("The shell still reached a TCP debug port on 127.0.0.1:9333.");
  const identity = await manager.run(userId, "id -u; id -un; ls -l /home/user/.linco/browser.sock 2>/dev/null || echo 'no control socket'", 15_000).catch((error) => ({ stdout: "", stderr: errorText(error), exitCode: 1 }));
  report.rows.push({ name: "same user socket", mode: "security", category: "cdp", ok: false, status: "tool", evidence: clip(identity.stdout || identity.stderr) });
  report.blockers.push("The shell and Chrome share uid 1000. The same user can still open the control socket or start its own Chrome. Loopback TCP 9333 is closed; that does not make the browser a separate trust domain. Public use is NO-GO.");
  report.blockers.push("The egress proxy pins the first DNS answer for proxied requests. It does not prove every subresource and does not re-check DNS after a TTL change.");
}

async function ask(
  report: ReliabilityReport,
  harness: Harness,
  manager: BoatSandboxManager,
  sessionId: string,
  name: string,
  category: string,
  profile: "browser" | "desktop" | "code" | "agent",
  prompt: string,
): Promise<number> {
  if (category === "click") {
    const userId = harness.db.getSession(sessionId)?.userId ?? "";
    const reset = await manager.browserAct(userId, "reset-click", { op: "navigate", url: "https://example.com" }).catch((error) => errorText(error));
    const ready = typeof reset !== "string" && (reset.url ?? "").includes("example.com");
    if (!ready) {
      report.rows.push({ name, mode: "language", category, ok: false, status: "reset", evidence: typeof reset === "string" ? clip(reset) : `reset url ${reset.url}` });
      return 0;
    }
  }
  const task = await instruct(harness, sessionId, prompt, profile);
  const evidence = await prove(harness, manager, task, category, prompt);
  const cost = harness.db.usageSummary(task.id).costUsd;
  report.rows.push({
    name,
    mode: "language",
    category,
    ok: evidence.length > 0 && task.status !== "waiting_approval",
    status: task.status,
    evidence: evidence || `status ${task.status}; tools ${toolNames(harness, task.id).join(",") || "none"}; errors ${errorTools(harness, task.id).join(",") || "none"}`,
  });
  return cost;
}

async function prove(harness: Harness, manager: BoatSandboxManager, task: Task, category: string, prompt: string): Promise<string> {
  const names = toolNames(harness, task.id);
  const userId = task.userId;
  if (category === "click") {
    const page = await manager.browserAct(userId, "prove-click", { op: "read" }).catch((error) => ({ url: errorText(error), title: "" }));
    return names.includes("browser_click") && (page.url ?? "").includes("iana.org") ? `tools ${names.join(",")}; url ${page.url}` : "";
  }
  if (category === "desktop") {
    const file = prompt.match(/proof\/[A-Za-z0-9._-]+\.txt/)?.[0] ?? "";
    const token = prompt.match(/PHASE105-TYPE-\d+/)?.[0] ?? "";
    const stages = await manager.fileStages(userId, file);
    const cat = stages.find((stage) => stage.stage === "cat");
    const typed = names.includes("desktop_click") && names.includes("desktop_type") || names.includes("desktop_batch");
    return typed && Boolean(cat?.detail.includes(token)) ? `tools ${names.join(",")}; cat ${clip(cat?.detail ?? "")}` : "";
  }
  if (category === "form") {
    const token = prompt.match(/PHASE105-FORM-\d+/)?.[0] ?? "";
    const page = await manager.browserAct(userId, "prove-form", { op: "read" }).catch((error) => ({ text: errorText(error), url: "" }));
    return names.includes("browser_fill") && token.length > 0 && (page.text ?? "").includes(token) ? `tools ${names.join(",")}` : "";
  }
  if (category === "code") {
    const token = prompt.match(/PHASE105-RUN-\d+/)?.[0] ?? "";
    const file = prompt.match(/proof\/main-105-\d+\.mjs/)?.[0] ?? "";
    const transcript = JSON.stringify(harness.db.getTranscript(task.sessionId));
    const stages = await manager.fileStages(userId, file);
    const source = stages.find((stage) => stage.stage === "cat")?.detail ?? "";
    const ran = (names.includes("shell_exec") || names.includes("code_run")) && source.includes(token) && transcript.includes(token);
    return ran ? `tools ${names.join(",")}; source has token` : "";
  }
  const index = prompt.match(/ALPHA-105-(\d+)/)?.[1] ?? "";
  const alpha = await manager.fileStages(userId, `proof/alpha-105-${index}.txt`);
  const beta = await manager.fileStages(userId, `proof/beta-105-${index}.txt`);
  const a = alpha.find((stage) => stage.stage === "cat")?.detail ?? "";
  const b = beta.find((stage) => stage.stage === "cat")?.detail ?? "";
  const children = harness.db.listChildren(task.id);
  const done = children.length >= 2 && children.every((child) => child.status === "succeeded" || child.status === "failed" || child.status === "cancelled");
  return names.includes("task_spawn") && done && a.includes(`ALPHA-105-${index}`) && b.includes(`BETA-105-${index}`) ? `tools ${names.join(",")}; children ${children.map((child) => child.status).join(",")}` : "";
}

async function instruct(harness: Harness, sessionId: string, prompt: string, profile: "browser" | "desktop" | "code" | "agent"): Promise<Task> {
  const task = await harness.submit(sessionId, prompt, { waitMs: 0, maxAttempts: 1, toolProfile: profile });
  const deadline = Date.now() + 150_000;
  const handled = new Set<string>();
  while (Date.now() < deadline) {
    const current = harness.db.getTask(task.id);
    if (!current) break;
    if (current.status === "waiting_approval") {
      for (const approval of harness.db.listApprovals(task.id)) {
        if (approval.status !== "pending" || handled.has(approval.id)) continue;
        handled.add(approval.id);
        const allowed = /^(desktop_|browser_|vm_browser_|fs_|task_)/.test(approval.toolName) || approval.toolName === "shell_exec" || approval.toolName === "code_run";
        harness.approve(task.id, approval.id, allowed ? "approved" : "denied");
      }
    }
    if (current.status !== "queued" && current.status !== "running" && current.status !== "waiting_children" && current.status !== "waiting_approval") return current;
    await sleep(400);
  }
  return harness.db.getTask(task.id) ?? task;
}

function errorTools(harness: Harness, taskId: string): string[] {
  const names: string[] = [];
  for (const trace of harness.db.listTraces(taskId)) {
    if (trace.kind !== "tool") continue;
    const data = trace.data as { phase?: string; isError?: boolean };
    if (data.phase !== "end" || !data.isError) continue;
    names.push(trace.name);
  }
  return names;
}

function toolNames(harness: Harness, taskId: string): string[] {
  const names: string[] = [];
  for (const trace of harness.db.listTraces(taskId)) {
    if (trace.kind !== "tool") continue;
    const data = trace.data as { phase?: string; isError?: boolean };
    if (data.phase !== "end" || data.isError) continue;
    names.push(trace.name);
  }
  return names;
}

function rates(rows: Row[]): Record<string, string> {
  const groups = ["browser", "click", "desktop", "form", "code", "subagents", "network", "cdp"];
  const out: Record<string, string> = {};
  for (const category of groups) {
    const group = rows.filter((row) => row.category === category && !row.evidence.startsWith("skipped:"));
    if (group.length === 0) continue;
    out[category] = `${group.filter((row) => row.ok).length}/${group.length}`;
  }
  return out;
}

function empty(): ReliabilityReport {
  return {
    createdAt: new Date().toISOString(),
    startedFrom: "8683678",
    mode: "skipped",
    performanceClaim: "none",
    publicReady: false,
    liveExecuted: false,
    liveReason: "",
    sandboxId: "",
    deleted: false,
    rows: [],
    rates: {},
    blockers: [],
    totals: { durationMs: 0, deepseekUsd: 0, boatUsd: 0 },
    notes: [],
  };
}

function writeReport(report: ReliabilityReport, dir: string, stem = "agent-reliability"): void {
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(report, null, 2);
  if (/sk-[A-Za-z0-9]{10,}|boat_[A-Za-z0-9_-]{8,}/.test(body)) throw new Error("report contains a secret");
  fs.writeFileSync(path.join(dir, `${stem}.json`), `${body}\n`);
  const lines = [
    "# Agent reliability",
    "",
    `Started from \`${report.startedFrom}\`. Mode \`${report.mode}\`. Public use is NO-GO.`,
    "",
    `Sandbox \`${report.sandboxId || "none"}\`. Deleted: ${report.deleted}.`,
    `Duration ${report.totals.durationMs} ms. DeepSeek $${report.totals.deepseekUsd}. Boat $${report.totals.boatUsd}.`,
    "",
    "## Rates",
    "",
    ...Object.entries(report.rates).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Rows",
    "",
    ...report.rows.map((row) => `- ${row.ok ? "pass" : "miss"} ${row.mode}/${row.category} ${row.name} [${row.status}] ${row.evidence}`),
    "",
    "## Blockers",
    "",
    ...report.blockers.map((item) => `- ${item}`),
    "",
    "## Notes",
    "",
    ...report.notes.map((item) => `- ${item}`),
    "",
  ];
  fs.writeFileSync(path.join(dir, `${stem}.md`), lines.join("\n"));
  if (stem !== "agent-reliability") return;
  const gates = [
    "# Security gates",
    "",
    "Public use: NO-GO.",
    "",
    ...report.blockers.map((item) => `- ${item}`),
    "",
    "Production approval is a user decision. The live matrix approves Boat tools inside the test process so a task can finish. That does not replace the user.",
    "",
    "Password, CAPTCHA, MFA, payment, purchase, send, and delete stay on the existing user-control path.",
    "",
  ];
  fs.writeFileSync(path.join(dir, "security-gates.md"), gates.join("\n"));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clip(value: string): string {
  return redact(value).replace(/\s+/g, " ").trim().slice(0, 240);
}

function redact(value: string): string {
  return value.replace(/sk-[A-Za-z0-9]{10,}/g, "sk-…").replace(/boat_[A-Za-z0-9_-]{8,}/g, "boat_…");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

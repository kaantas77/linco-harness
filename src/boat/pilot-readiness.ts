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
import { typeIntoEditor, type DriverCaller } from "./desktop-flow.js";
import { LIVE_LIMITS } from "./live-check.js";
import { BoatSandboxManager } from "./manager.js";
import { classifyDirectFailure, type ChannelStage, type FailureClass } from "./probe.js";
import { redactBoat } from "./redact.js";

export interface PilotRow {
  name: string;
  mode: "controlled" | "language" | "security";
  ok: boolean;
  evidence: string;
}

export interface PilotReport {
  createdAt: string;
  startedFrom: "162b4f9";
  mode: "live" | "skipped";
  performanceClaim: "none";
  liveExecuted: boolean;
  liveReason: string;
  publicReady: false;
  limits: typeof LIVE_LIMITS;
  sandboxId: string | null;
  deleted: boolean;
  rootCause: FailureClass;
  channel: ChannelStage[];
  missingFile: FailureClass;
  blockers: string[];
  rows: PilotRow[];
  rates: { desktop: string; language: string; security: string };
  totals: { durationMs: number; deepseekUsd: number; boatUsd: number };
  notes: string[];
}

export async function runPilotReadiness(input: {
  boatApiKey?: string;
  deepseekApiKey?: string;
  boatBaseUrl?: string;
  reportDir?: string;
}): Promise<PilotReport> {
  const report = empty();
  const flush = () => writeReport(report, input.reportDir ?? "reports");
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-pilot-"));
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
      maxTurns: 6,
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
  const user = harness.createUser("Pilot");
  const session = harness.createSession(user.id);
  let sandboxId = "";
  let deepseekUsd = 0;
  const boatUsd = async () => (await manager.describe(user.id)).usage?.dollars ?? 0;
  const over = async () => {
    if (Date.now() - started > 16 * 60_000) return "stopped inside the 16 minute subgroup";
    const spent = await boatUsd().catch(() => 0);
    if (spent >= LIVE_LIMITS.boatUsd) return "boat dollar cap";
    if (deepseekUsd >= LIVE_LIMITS.deepseekUsd) return "deepseek dollar cap";
    return "";
  };
  try {
    await manager.ensure(user.id);
    sandboxId = (await manager.describe(user.id)).sandboxId ?? "";
    report.sandboxId = sandboxId;
    report.channel = await manager.channelStages(user.id);
    report.rootCause = classifyDirectFailure(report.channel);
    const missing = report.channel.filter((stage) => stage.stage === "readMissing" || stage.stage === "catMissing").map((stage) => ({
      ...stage,
      stage: stage.stage === "readMissing" ? "readText" : "cat",
    }));
    report.missingFile = classifyDirectFailure(missing);
    flush();

    for (let index = 1; index <= 10; index += 1) {
      const reason = await over();
      const token = `PHASE104-TYPE-${index}`;
      const relative = `proof/pilot-${index}.txt`;
      if (reason) {
        report.rows.push({ name: `type ${index}`, mode: "controlled", ok: false, evidence: `skipped: ${reason}` });
        continue;
      }
      const before = await manager.fileStages(user.id, relative);
      const absent = before.some((stage) => stage.stage === "cat" && /no such file|cannot stat/i.test(stage.detail));
      const typed = await manager.withDesktop(user.id, `type-${index}`, (call) => {
        const driver: DriverCaller = { call, schema: (name) => manager.schema(name) };
        return typeIntoEditor(driver, `/home/user/linco/${relative}`, token);
      });
      const after = await manager.fileStages(user.id, relative);
      const cat = after.find((stage) => stage.stage === "cat");
      const read = after.find((stage) => stage.stage === "readText");
      const verified = Boolean(cat?.apiOk && cat.detail.includes(token));
      const called = typed.calls.includes("click") && typed.calls.includes("type_text");
      const leftover = before.some((stage) => stage.detail.includes(token));
      report.rows.push({
        name: `type ${index}`,
        mode: "controlled",
        ok: absent && typed.ok && called && verified && !leftover,
        evidence: `absent ${absent}; calls ${typed.calls.join(",")}; cat ${cat?.httpStatus ?? "ok"} ${cat?.code ?? ""} ${clip(cat?.detail ?? "")}; readText ${read?.httpStatus ?? "ok"} ${read?.code ?? ""} ${clip(read?.detail ?? "")}; window ${typed.kind}`,
      });
      flush();
    }

    await securityRows(report, manager, user.id);
    if (!(await over())) {
      harness.start();
      deepseekUsd += await ask(report, harness, session.id, "open", "browser", "browser_open_read ile https://example.com aç. Başlık Example Domain değilse dur.", async (task) => {
        const page = await manager.browserAct(user.id, "nl-open", { op: "read" }).catch((error) => ({ title: "", url: errorText(error) }));
        const names = toolNames(harness, task.id);
        return names.includes("browser_open_read") && page.title === "Example Domain"
          ? `tools ${names.join(",")}; title ${JSON.stringify(page.title)}`
          : "";
      });
      deepseekUsd += await ask(report, harness, session.id, "click", "browser", "example.com sayfasında More information bağlantısına browser_click ile tıkla. Yeni snapshot kullan.", async (task) => {
        const page = await manager.browserAct(user.id, "nl-click", { op: "read" }).catch((error) => ({ title: "", url: errorText(error) }));
        const names = toolNames(harness, task.id);
        return names.includes("browser_click") && (page.url ?? "").includes("iana.org") ? `tools ${names.join(",")}; url ${page.url}` : "";
      });
      deepseekUsd += await ask(report, harness, session.id, "form", "browser", "https://httpbin.org/forms/post formunda müşteri adına PHASE104-FORM yaz ve gönder. browser_fill ve browser_click kullan.", async (task) => {
        const page = await manager.browserAct(user.id, "nl-form", { op: "read" }).catch((error) => ({ title: "", url: "", text: errorText(error) }));
        const names = toolNames(harness, task.id);
        const body = `${page.text ?? ""}`;
        return names.includes("browser_fill") && body.includes("PHASE104-FORM") ? `tools ${names.join(",")}; body has token` : "";
      });
      deepseekUsd += await ask(report, harness, session.id, "desktop", "desktop", "Masaüstünde nano ile proof/nl-104.txt dosyasına PHASE104-NL yaz ve kaydet. Kabuk kullanma. desktop_click ve desktop_type çağır.", async (task) => {
        const names = toolNames(harness, task.id);
        const stages = await manager.fileStages(user.id, "proof/nl-104.txt");
        const cat = stages.find((stage) => stage.stage === "cat");
        return names.includes("desktop_type") && names.includes("desktop_click") && Boolean(cat?.detail.includes("PHASE104-NL"))
          ? `tools ${names.join(",")}; cat ${clip(cat?.detail ?? "")}`
          : "";
      });
      deepseekUsd += await ask(report, harness, session.id, "code", "code", "proof/main-104.mjs dosyasına console.log('PHASE104-RUN') yaz ve node ile çalıştır.", async (task) => {
        const names = toolNames(harness, task.id);
        const ran = await manager.run(user.id, "node /home/user/linco/proof/main-104.mjs", 15_000).catch((error) => ({ stdout: "", stderr: errorText(error), exitCode: 1 }));
        return (names.includes("code_run") || names.includes("shell_exec")) && ran.stdout.includes("PHASE104-RUN")
          ? `tools ${names.join(",")}; stdout ${clip(ran.stdout)}`
          : "";
      });
      deepseekUsd += await ask(report, harness, session.id, "subagents", "agent", "İki çocuk görev başlat. Biri proof/alpha-104.txt içine ALPHA-104 yazsın, diğeri proof/beta-104.txt içine BETA-104 yazsın.", async (task) => {
        const names = toolNames(harness, task.id);
        const alpha = await manager.fileStages(user.id, "proof/alpha-104.txt");
        const beta = await manager.fileStages(user.id, "proof/beta-104.txt");
        const a = alpha.find((stage) => stage.stage === "cat")?.detail ?? "";
        const b = beta.find((stage) => stage.stage === "cat")?.detail ?? "";
        return names.includes("task_spawn") && a.includes("ALPHA-104") && b.includes("BETA-104") ? `tools ${names.join(",")}` : "";
      });
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
    report.notes.push("Desktop success requires a new file, click, type_text, and a cat of that token. A model status is not evidence.");
    report.notes.push("CDP stays on 127.0.0.1:9333. A same-user shell that can open that port is a production blocker.");
    flush();
  }
  return report;
}

async function securityRows(report: PilotReport, manager: BoatSandboxManager, userId: string): Promise<void> {
  const metadata = await manager.browserAct(userId, "sec-meta", { op: "navigate", url: "http://169.254.169.254/latest/meta-data/" }).then(() => "accepted", (error) => errorText(error));
  const metaBlocked = /blocked|private|metadata/i.test(metadata);
  report.rows.push({ name: "metadata url", mode: "security", ok: metaBlocked, evidence: clip(metadata) });
  if (!metaBlocked) report.blockers.push("The metadata address was not refused before Chrome opened it.");
  const redirect = await manager.browserAct(userId, "sec-redirect", {
    op: "navigate",
    url: "https://httpbin.org/redirect-to?url=http://169.254.169.254/latest/meta-data/",
  }).then((page) => page.url ?? "accepted", (error) => errorText(error));
  const redirectBlocked = /blocked|private|metadata/i.test(redirect) && !redirect.startsWith("http://169.254.169.254");
  const redirectTimedOut = /cdp timeout Page.navigate/i.test(redirect);
  report.rows.push({ name: "metadata redirect", mode: "security", ok: redirectBlocked, evidence: clip(redirect) });
  if (!redirectBlocked && redirectTimedOut) {
    report.blockers.push("The metadata redirect did not return a verified refusal. Chrome timed out on Page.navigate, so the redirect is not proven blocked and the metadata URL was not observed.");
  } else if (!redirectBlocked) {
    report.blockers.push("A public URL that redirects to the metadata address was not refused.");
  }
  const opened = await manager.browserAct(userId, "sec-chrome", { op: "navigate", url: "https://example.com" }).catch((error) => errorText(error));
  const identity = await manager.run(userId, "id -u; id -un; ps -o user= -C chrome -C google-chrome -C chromium 2>/dev/null | sort -u | head", 15_000).catch((error) => ({ stdout: "", stderr: errorText(error), exitCode: 1 }));
  const debug = await manager.run(userId, "curl -sS -m 3 -o /tmp/linco-cdp.json -w '%{http_code}' http://127.0.0.1:9333/json/version || true", 15_000).catch((error) => ({ stdout: errorText(error), stderr: "", exitCode: 1 }));
  const sameUser = /200/.test(debug.stdout);
  report.rows.push({
    name: "cdp same user",
    mode: "security",
    ok: false,
    evidence: `chrome ${typeof opened === "string" ? clip(opened) : opened.url ?? ""}; identity ${clip(identity.stdout || identity.stderr)}; debug http ${clip(debug.stdout)}`,
  });
  if (sameUser) report.blockers.push("A shell in the VM reached Chrome's loopback debug port. The browser user is not separate from the shell user.");
  report.blockers.push("The VM checks the final URL text. It does not resolve DNS again, and it does not inspect subresource requests. That remains a production blocker.");
}

async function ask(
  report: PilotReport,
  harness: Harness,
  sessionId: string,
  name: string,
  profile: "browser" | "desktop" | "code" | "agent",
  prompt: string,
  check: (task: Task) => Promise<string>,
): Promise<number> {
  const task = await instruct(harness, sessionId, prompt, profile);
  const evidence = await check(task);
  const cost = harness.db.usageSummary(task.id).costUsd;
  report.rows.push({
    name,
    mode: "language",
    ok: evidence.length > 0,
    evidence: evidence || `status ${task.status}; tools ${toolNames(harness, task.id).join(",")}`,
  });
  return cost;
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

function toolNames(harness: Harness, taskId: string): string[] {
  const names: string[] = [];
  for (const trace of harness.db.listTraces(taskId)) {
    if (trace.kind !== "tool") continue;
    const data = trace.data as { phase?: string };
    if (data.phase !== "end") continue;
    names.push(trace.name);
  }
  return names;
}

function rates(rows: PilotRow[]): PilotReport["rates"] {
  const rate = (mode: PilotRow["mode"]) => {
    const group = rows.filter((row) => row.mode === mode && !row.evidence.startsWith("skipped:"));
    return `${group.filter((row) => row.ok).length}/${group.length}`;
  };
  return { desktop: rate("controlled"), language: rate("language"), security: rate("security") };
}

function empty(): PilotReport {
  return {
    createdAt: new Date().toISOString(),
    startedFrom: "162b4f9",
    mode: "skipped",
    performanceClaim: "none",
    liveExecuted: false,
    liveReason: "",
    publicReady: false,
    limits: LIVE_LIMITS,
    sandboxId: null,
    deleted: false,
    rootCause: { source: "unknown", summary: "" },
    channel: [],
    missingFile: { source: "unknown", summary: "" },
    blockers: [],
    rows: [],
    rates: { desktop: "0/0", language: "0/0", security: "0/0" },
    totals: { durationMs: 0, deepseekUsd: 0, boatUsd: 0 },
    notes: [],
  };
}

function writeReport(report: PilotReport, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pilot-readiness.json"), `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    "# Pilot readiness",
    "",
    `Started from \`${report.startedFrom}\`. ${report.createdAt}.`,
    "",
    `Live: ${report.liveExecuted ? "yes" : "no"}. ${report.liveReason}`,
    `Sandbox: ${report.sandboxId ?? "none"}. Deleted: ${report.deleted ? "yes" : "no"}.`,
    "Public use: no.",
    "",
    "## Direct channel",
    "",
    `${report.rootCause.source}: ${report.rootCause.summary}`,
    `Missing file: ${report.missingFile.source}: ${report.missingFile.summary}`,
    "",
    ...report.channel.map((stage) => `- ${stage.stage} api ${stage.apiOk ? "ok" : "fail"} http ${stage.httpStatus ?? "-"} ${stage.code} state ${stage.sandboxState}: ${stage.detail}`),
    "",
    "## Results",
    "",
    `Desktop ${report.rates.desktop}. Language ${report.rates.language}. Security ${report.rates.security}.`,
    "",
    ...report.rows.map((row) => `- ${row.ok ? "ok" : "miss"} ${row.mode} ${row.name}: ${row.evidence}`),
    "",
    "## Production blockers",
    "",
    ...report.blockers.map((item) => `- ${item}`),
    "",
    `Duration ${report.totals.durationMs} ms. DeepSeek $${report.totals.deepseekUsd}. Boat $${report.totals.boatUsd}. performanceClaim: none.`,
    "",
    ...report.notes.map((note) => `- ${note}`),
    "",
  ];
  fs.writeFileSync(path.join(dir, "pilot-readiness.md"), lines.join("\n"));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(value: string): string {
  return redactBoat(value).replace(/sk-[A-Za-z0-9]+/g, "sk-[redacted]");
}

function clip(value: string): string {
  return redact(value).replace(/\s+/g, " ").slice(0, 220);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

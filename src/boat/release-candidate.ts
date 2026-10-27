import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Harness } from "../agent/runtime.js";
import { loadConfig } from "../config.js";
import { LincoDb } from "../db/database.js";
import { createDeepSeek } from "../llm/deepseek.js";
import type { Task } from "../types.js";
import { createBoatClient, type BoatClient } from "./client.js";
import { typeIntoEditor, type DriverCaller } from "./desktop-flow.js";
import { LIVE_LIMITS } from "./live-check.js";
import { BoatSandboxManager } from "./manager.js";
import { redactBoat } from "./redact.js";
import type { VmBrowserResult } from "./vm-browser.js";

export interface CandidateRow {
  name: string;
  category: "browser" | "computer" | "agent";
  mode: "controlled" | "language";
  ok: boolean;
  evidence: string;
}

export interface ReleaseCandidateReport {
  createdAt: string;
  startedFrom: "0406add";
  mode: "live" | "skipped";
  performanceClaim: "none";
  liveExecuted: boolean;
  liveReason: string;
  publicReady: false;
  limits: typeof LIVE_LIMITS;
  sandboxId: string | null;
  deleted: boolean;
  adaptedFrom: string[];
  rows: CandidateRow[];
  rates: { browser: string; computer: string; agent: string };
  totals: { durationMs: number; deepseekUsd: number; boatUsd: number };
  notes: string[];
}

const PAGES = [
  ["https://example.com", "Example Domain"],
  ["https://example.org", "Example Domain"],
  ["https://example.com/", "Example Domain"],
  ["https://httpbin.org/json", ""],
  ["https://httpbin.org/html", ""],
  ["http://example.com", "Example Domain"],
] as const;

export async function runReleaseCandidate(input: {
  boatApiKey?: string;
  deepseekApiKey?: string;
  boatBaseUrl?: string;
  reportDir?: string;
}): Promise<ReleaseCandidateReport> {
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-rc-"));
  const managerDb = new LincoDb(path.join(root, "linco.sqlite"));
  let creates = 0;
  const inner = createBoatClient({ apiKey: input.boatApiKey, basePath: input.boatBaseUrl });
  const client = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "create") {
        return async (request: Parameters<BoatClient["create"]>[0]) => {
          creates += 1;
          return target.create(request);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as BoatClient;
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
  const user = harness.createUser("Candidate");
  const session = harness.createSession(user.id);
  let sandboxId = "";
  let deepseekUsd = 0;
  const boatUsd = async () => (await manager.describe(user.id)).usage?.dollars ?? 0;
  const over = async () => {
    if (Date.now() - started > 12 * 60_000) return "stopped inside the 12 minute subgroup";
    const spent = await boatUsd().catch(() => 0);
    if (spent >= LIVE_LIMITS.boatUsd) return "boat dollar cap";
    return "";
  };
  try {
    await manager.ensure(user.id);
    sandboxId = (await manager.describe(user.id)).sandboxId ?? "";
    report.sandboxId = sandboxId;
    const driver: DriverCaller = {
      call: (tool, args) => manager.desktop(user.id, `flow-${tool}`, tool, args),
      schema: (name) => manager.schema(name),
    };
    let previous: VmBrowserResult | undefined;
    for (const [url, title] of PAGES) {
      if (await over()) {
        report.rows.push({ name: `open ${url}`, category: "browser", mode: "controlled", ok: false, evidence: "skipped: budget" });
        continue;
      }
      try {
        const page = await manager.browserAct(user.id, `open-${url}`, { op: "openRead", url, expectedTitle: title || undefined });
        const urlOk = (page.url ?? "").includes(new URL(url).hostname);
        const titleOk = !title || page.title === title;
        const fresh = Boolean(page.snapshot?.snapshotId) && page.snapshot?.snapshotId !== previous?.snapshot?.snapshotId;
        previous = page;
        report.rows.push({
          name: `open ${url}`,
          category: "browser",
          mode: "controlled",
          ok: page.verified === true && urlOk && titleOk && fresh,
          evidence: `verified ${String(page.verified)}; url ${page.url ?? ""}; title ${JSON.stringify(page.title ?? "")}; snapshot ${page.snapshot?.snapshotId ?? 0}`,
        });
      } catch (error) {
        report.rows.push({ name: `open ${url}`, category: "browser", mode: "controlled", ok: false, evidence: clip(errorText(error)) });
      }
      flush();
    }

    const home = await manager.browserAct(user.id, "click-home", { op: "navigate", url: "https://example.com" }).catch((error) => {
      report.rows.push({ name: "click setup", category: "browser", mode: "controlled", ok: false, evidence: clip(errorText(error)) });
      return undefined;
    });
    const link = home?.snapshot?.elements.find((element) => element.role === "link" && /more information|learn more/i.test(element.name) && !element.disabled)
      ?? home?.snapshot?.elements.find((element) => element.role === "link" && element.name !== "unnamed" && !element.disabled);
    if (home?.snapshot && link) {
      for (let index = 0; index < 4; index += 1) {
        const current = index === 0 ? home : await manager.browserAct(user.id, `click-back-${index}`, { op: "navigate", url: "https://example.com" });
        const target = current.snapshot?.elements.find((element) => element.role === "link" && /more information|learn more/i.test(element.name) && !element.disabled)
          ?? current.snapshot?.elements.find((element) => element.role === "link" && element.name !== "unnamed" && !element.disabled);
        if (!current.snapshot || !target) {
          report.rows.push({ name: `click ${index + 1}`, category: "browser", mode: "controlled", ok: false, evidence: "no link in the fresh snapshot" });
          continue;
        }
        const clicked = await manager.browserAct(user.id, `click-${index}`, { op: "clickRef", ref: target.ref, snapshotId: current.snapshot.snapshotId });
        const moved = clicked.url !== current.url && clicked.snapshot !== undefined && clicked.snapshot.snapshotId !== current.snapshot.snapshotId;
        report.rows.push({
          name: `click ${index + 1}`,
          category: "browser",
          mode: "controlled",
          ok: moved,
          evidence: `from ${current.url ?? ""} to ${clicked.url ?? ""}; ref ${target.ref}; snapshot ${current.snapshot.snapshotId} -> ${clicked.snapshot?.snapshotId ?? 0}`,
        });
      }
    } else if (home) {
      report.rows.push({ name: "click 1", category: "browser", mode: "controlled", ok: false, evidence: "example.com snapshot had no link" });
    }

    for (let index = 0; index < 3; index += 1) {
      const token = `PHASE103-FORM-${index + 1}`;
      try {
        const page = await manager.browserAct(user.id, `form-${index}`, { op: "navigate", url: "https://httpbin.org/forms/post" });
        const field = page.snapshot?.elements.find((element) => element.role === "textbox" && /customer|cust/i.test(element.name));
        if (!page.snapshot || !field) throw new Error("customer textbox was not in the snapshot");
        const filled = await manager.browserAct(user.id, `form-fill-${index}`, { op: "fillRef", ref: field.ref, snapshotId: page.snapshot.snapshotId, text: token });
        const button = filled.snapshot?.elements.find((element) => element.role === "button" && !element.disabled);
        if (!filled.snapshot || !button) throw new Error("submit button was not in the fresh snapshot");
        const sent = await manager.browserAct(user.id, `form-send-${index}`, { op: "clickRef", ref: button.ref, snapshotId: filled.snapshot.snapshotId });
        const read = await manager.browserAct(user.id, `form-read-${index}`, { op: "read" });
        const body = `${read.text ?? ""}\n${read.url ?? ""}`;
        report.rows.push({
          name: `form ${index + 1}`,
          category: "browser",
          mode: "controlled",
          ok: body.includes(token) && sent.snapshot?.snapshotId !== page.snapshot.snapshotId,
          evidence: `url ${sent.url ?? ""}; body has token ${body.includes(token)}; snapshot ${page.snapshot.snapshotId} -> ${sent.snapshot?.snapshotId ?? 0}`,
        });
      } catch (error) {
        report.rows.push({ name: `form ${index + 1}`, category: "browser", mode: "controlled", ok: false, evidence: clip(errorText(error)) });
      }
    }

    const staleBase = await manager.browserAct(user.id, "stale-base", { op: "snapshot" }).catch((error) => {
      report.rows.push({ name: "stale ref", category: "browser", mode: "controlled", ok: false, evidence: clip(errorText(error)) });
      return undefined;
    });
    if (staleBase?.snapshot) {
      await manager.browserAct(user.id, "stale-nav", { op: "navigate", url: "https://example.org" });
      const stale = await manager.browserAct(user.id, "stale-click", {
        op: "clickRef",
        ref: staleBase.snapshot.elements[0]?.ref ?? "b1",
        snapshotId: staleBase.snapshot.snapshotId,
      }).then(() => "accepted", (error) => errorText(error));
      report.rows.push({
        name: "stale ref",
        category: "browser",
        mode: "controlled",
        ok: /stale/.test(stale),
        evidence: clip(stale),
      });
    }

    for (let index = 0; index < 4; index += 1) {
      if (await over()) {
        report.rows.push({ name: `type ${index + 1}`, category: "computer", mode: "controlled", ok: false, evidence: "skipped: budget" });
        continue;
      }
      const token = `PHASE103-TYPE-${index + 1}`;
      const relative = `proof/type-${index + 1}.txt`;
      const typed = await typeIntoEditor(driver, `/home/user/linco/${relative}`, token);
      const raw = await proveFile(manager, user.id, relative);
      const called = typed.calls.includes("click") && (typed.calls.includes("type_text") || typed.calls.includes("hotkey"));
      report.rows.push({
        name: `type ${index + 1}`,
        category: "computer",
        mode: "controlled",
        ok: typed.ok && called && raw.trim() === token,
        evidence: `calls ${typed.calls.join(",")}; raw ${JSON.stringify(raw)}`,
      });
      flush();
    }

    const hold = manager.browserAct(user.id, "lock-a", { op: "hold" });
    await sleep(300);
    const blocked = await manager.desktop(user.id, "lock-b", "get_desktop_state", {}).then(() => "acquired", (error) => errorText(error));
    await hold.catch(() => undefined);
    const other = harness.createSession(user.id);
    await manager.ensure(user.id);
    report.rows.push({
      name: "desktop lock",
      category: "computer",
      mode: "controlled",
      ok: /desktop is in use/.test(blocked) && creates === 1 && other.id !== session.id,
      evidence: `lock ${clip(blocked)}; creates ${creates}`,
    });

    if (!(await over())) {
      harness.start();
      await ask(report, harness, session.id, "open site", "browser", "browser_open_read ile https://example.com aç. Başlık Example Domain değilse dur.", async (task) => {
        const page = await manager.browserAct(user.id, "nl-open", { op: "read" }).catch((error) => ({ title: "", url: errorText(error) }));
        const names = toolNames(harness, task.id);
        return { ok: names.includes("browser_open_read") && page.title === "Example Domain", evidence: `status ${task.status}; tools ${names.join(",")}; title ${JSON.stringify(page.title)}` };
      }, (cost) => {
        deepseekUsd += cost;
      });
      await ask(report, harness, session.id, "edit file", "code", "proof/edited.txt dosyasına PHASE103-EDIT yaz.", async (task) => {
        const raw = await proveFile(manager, user.id, "proof/edited.txt");
        const names = toolNames(harness, task.id);
        return { ok: raw.includes("PHASE103-EDIT") && (names.includes("fs_write") || names.includes("shell_exec")), evidence: `status ${task.status}; tools ${names.join(",")}; raw ${JSON.stringify(raw)}` };
      }, (cost) => {
        deepseekUsd += cost;
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
    report.totals = {
      durationMs: Date.now() - started,
      deepseekUsd: round(deepseekUsd),
      boatUsd: round(spentBoat),
    };
    report.rates = rates(report.rows);
    report.notes.push("The ten-by-ten matrix was split. This run is the subgroup that fits the existing dollar and time caps.");
    report.notes.push("An earlier deleted sandbox bx_mx9dpp9w opened 6/6 pages and rejected a stale ref. Its link clicks stayed on example.com and its form replies did not contain the token. This run is after that fill and click correction.");
    report.notes.push("Chrome debug stays on 127.0.0.1:9333. --remote-allow-origins is the loopback origin, not a wildcard. CDP is still reachable by any process inside that VM, so this is a controlled pilot.");
    report.notes.push("DeepSeek image reading was not repeated. Web evidence is the accessibility snapshot and the final URL.");
    flush();
  }
  return report;
}

function empty(): ReleaseCandidateReport {
  return {
    createdAt: new Date().toISOString(),
    startedFrom: "0406add",
    mode: "skipped",
    performanceClaim: "none",
    liveExecuted: false,
    liveReason: "",
    publicReady: false,
    limits: LIVE_LIMITS,
    sandboxId: null,
    deleted: false,
    adaptedFrom: [
      "OpenMausBot server/remote-computer.ts CDP_HELPER_SOURCE: Accessibility.getFullAXTree, b{backendNodeId}, fresh snapshot, USER_TAKEOVER_REQUIRED",
      "OpenMausBot server/computer-proxy.ts open_url and waitForNavigation: a tool reply is not proof",
      "OpenMausBot gateway/src/execution-router.ts routeExecution: Linco uses a profile on submit, not a second gateway",
      "OpenMausBot gateway/src/hermes-web.ts: Serper and Tavily adapters fail when the key is unset",
      "OpenMausBot server/remote-computer.ts computer_batch: desktop_batch stops at the first error under one lock",
    ],
    rows: [],
    rates: { browser: "0/0", computer: "0/0", agent: "0/0" },
    totals: { durationMs: 0, deepseekUsd: 0, boatUsd: 0 },
    notes: [],
  };
}

async function ask(
  report: ReleaseCandidateReport,
  harness: Harness,
  sessionId: string,
  name: string,
  profile: "browser" | "code",
  prompt: string,
  check: (task: Task) => Promise<{ ok: boolean; evidence: string }>,
  addCost: (cost: number) => void,
): Promise<void> {
  const task = await instruct(harness, sessionId, prompt, profile);
  const checked = await check(task);
  const cost = harness.db.usageSummary(task.id).costUsd;
  addCost(cost);
  report.rows.push({ name, category: "agent", mode: "language", ok: checked.ok, evidence: `${checked.evidence}; deepseek ${cost}` });
}

async function instruct(harness: Harness, sessionId: string, prompt: string, profile: "browser" | "code"): Promise<Task> {
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
        const allowed = approval.toolName.startsWith("desktop_") || approval.toolName.startsWith("vm_browser_") || approval.toolName.startsWith("browser_") || approval.toolName.startsWith("fs_") || approval.toolName === "shell_exec";
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

async function proveFile(manager: BoatSandboxManager, userId: string, relativePath: string): Promise<string> {
  try {
    return (await manager.read(userId, relativePath)).text;
  } catch (error) {
    const via = await manager.run(userId, `cat /home/user/linco/${relativePath}`, 15_000).catch(() => ({ stdout: "", stderr: errorText(error), exitCode: 1 }));
    if (via.exitCode === 0) return via.stdout;
    return `READ FAILED ${errorText(error)}`;
  }
}

function rates(rows: CandidateRow[]): { browser: string; computer: string; agent: string } {
  const rate = (category: CandidateRow["category"]) => {
    const group = rows.filter((row) => row.category === category && !row.evidence.startsWith("skipped:"));
    const ok = group.filter((row) => row.ok).length;
    return `${ok}/${group.length}`;
  };
  return { browser: rate("browser"), computer: rate("computer"), agent: rate("agent") };
}

function writeReport(report: ReleaseCandidateReport, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, "release-candidate.json"), json);
  const lines = [
    "# Release candidate",
    "",
    `Started from \`${report.startedFrom}\`. ${report.createdAt}.`,
    "",
    `Live: ${report.liveExecuted ? "yes" : "no"}. ${report.liveReason}`,
    `Sandbox: ${report.sandboxId ?? "none"}. Deleted: ${report.deleted ? "yes" : "no"}.`,
    `Public use: no. This remains a controlled pilot.`,
    "",
    "## Adapted from OpenMausBot",
    "",
    ...report.adaptedFrom.map((line) => `- ${line}`),
    "",
    "## Independent results",
    "",
    `Browser ${report.rates.browser}. Computer ${report.rates.computer}. Agent ${report.rates.agent}.`,
    "",
    ...report.rows.map((row) => `- ${row.ok ? "ok" : "miss"} ${row.mode} ${row.category} ${row.name}: ${row.evidence}`),
    "",
    `Duration ${report.totals.durationMs} ms. DeepSeek $${report.totals.deepseekUsd}. Boat $${report.totals.boatUsd}. performanceClaim: none.`,
    "",
    ...report.notes.map((note) => `- ${note}`),
    "",
  ];
  fs.writeFileSync(path.join(dir, "release-candidate.md"), lines.join("\n"));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(value: string): string {
  return redactBoat(value).replace(/sk-[A-Za-z0-9]+/g, "sk-[redacted]");
}

function clip(value: string): string {
  return redact(value).replace(/\s+/g, " ").slice(0, 280);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

export interface DiagnosisRow {
  name: string;
  session: "fresh" | "same";
  profile: string;
  status: string;
  offered: string[];
  priorMessages: number;
  turns: Array<{ stopReason: string; calls: string[] }>;
  tools: Array<{ name: string; isError: boolean; args: string; result: string }>;
  correction: { sent: boolean; starved: boolean; turns: number } | null;
  maxTurns: number;
}

export interface DiagnosisReport {
  createdAt: string;
  startedFrom: "aee60fc";
  sandboxId: string;
  deleted: boolean;
  rows: DiagnosisRow[];
  totals: { durationMs: number; deepseekUsd: number; boatUsd: number };
  notes: string[];
}

export async function runActionDiagnosis(input: {
  boatApiKey?: string;
  deepseekApiKey?: string;
  boatBaseUrl?: string;
  reportDir?: string;
}): Promise<DiagnosisReport> {
  const report: DiagnosisReport = {
    createdAt: new Date().toISOString(),
    startedFrom: "aee60fc",
    sandboxId: "",
    deleted: false,
    rows: [],
    totals: { durationMs: 0, deepseekUsd: 0, boatUsd: 0 },
    notes: [],
  };
  const dir = input.reportDir ?? "reports";
  const flush = () => writeDiagnosis(report, dir);
  if (!input.boatApiKey || !input.deepseekApiKey) {
    report.notes.push(!input.boatApiKey ? "BOAT_API_KEY is unset" : "DEEPSEEK_API_KEY is unset");
    flush();
    return report;
  }
  const started = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-106-diag-"));
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
      workerCount: 1,
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
  const user = harness.createUser("Diagnosis");
  const desktopSession = harness.createSession(user.id);
  const codeSession = harness.createSession(user.id);
  let sandboxId = "";
  let deepseekUsd = 0;
  try {
    await manager.ensure(user.id);
    sandboxId = (await manager.describe(user.id)).sandboxId ?? "";
    report.sandboxId = sandboxId;
    harness.start();
    const jobs: Array<[string, string, "fresh" | "same", "desktop" | "code", string]> = [
      ["desktop fresh", desktopSession.id, "fresh", "desktop", "Masaüstünde nano ile proof/diag-desk.txt dosyasına PHASE106-DESK yaz ve kaydet. Kabuk kullanma."],
      ["code fresh", codeSession.id, "fresh", "code", "proof/diag-code.mjs kodunu yaz ve node ile çalıştır. console.log('PHASE106-CODE')"],
      ["desktop same", desktopSession.id, "same", "desktop", "Masaüstünde nano ile proof/diag-desk-2.txt dosyasına PHASE106-DESK-2 yaz ve kaydet. Kabuk kullanma."],
      ["code same", codeSession.id, "same", "code", "proof/diag-code-2.mjs kodunu yaz ve node ile çalıştır. console.log('PHASE106-CODE-2')"],
    ];
    for (const [name, sessionId, session, profile, prompt] of jobs) {
      if (Date.now() - started > 12 * 60_000) {
        report.notes.push("stopped inside the diagnosis window");
        break;
      }
      const task = await instruct(harness, sessionId, prompt, profile);
      deepseekUsd += harness.db.usageSummary(task.id).costUsd;
      report.rows.push(readRow(harness, task, name, session, profile));
      flush();
    }
  } catch (error) {
    report.notes.push(error instanceof Error ? error.message : String(error));
  } finally {
    const boatUsd = await manager.describe(user.id).then((item) => item.usage?.dollars ?? 0).catch(() => 0);
    if (sandboxId) {
      await manager.stop(user.id).catch(() => undefined);
      try {
        await client.delete(sandboxId);
        report.deleted = true;
      } catch (error) {
        report.notes.push(error instanceof Error ? error.message : String(error));
      }
    }
    await harness.stop().catch(() => undefined);
    managerDb.close();
    fs.rmSync(root, { recursive: true, force: true });
    report.totals = { durationMs: Date.now() - started, deepseekUsd: Math.round(deepseekUsd * 1_000_000) / 1_000_000, boatUsd: Math.round(boatUsd * 1_000_000) / 1_000_000 };
    report.notes.push("Each row is one task. fresh starts from an empty transcript. same continues that session. Test approval is not a production approval.");
    flush();
  }
  return report;
}

function readRow(harness: Harness, task: Task, name: string, session: "fresh" | "same", profile: string): DiagnosisRow {
  const traces = harness.db.listTraces(task.id);
  const offered = traces.find((trace) => trace.kind === "model" && trace.name === "tools");
  const offeredData = (offered?.data ?? {}) as { names?: string[]; priorMessages?: number; maxTurns?: number };
  const turns = traces.flatMap((trace) => {
    if (trace.kind !== "model" || trace.name !== "turn") return [];
    const data = trace.data as { stopReason?: string; calls?: string[] };
    return [{ stopReason: data.stopReason ?? "", calls: data.calls ?? [] }];
  });
  const tools = traces.flatMap((trace) => {
    if (trace.kind !== "tool") return [];
    const data = trace.data as { phase?: string; isError?: boolean; args?: string; result?: string };
    if (data.phase !== "end") return [];
    const start = traces.find((item) => item.kind === "tool" && item.name === trace.name && (item.data as { toolCallId?: string }).toolCallId === (trace.data as { toolCallId?: string }).toolCallId && (item.data as { phase?: string }).phase === "start");
    return [{ name: trace.name, isError: data.isError === true, args: (start?.data as { args?: string } | undefined)?.args ?? "", result: data.result ?? "" }];
  });
  const correction = traces.find((trace) => trace.kind === "model" && trace.name === "correction");
  const correctionData = (correction?.data ?? null) as { starved?: boolean; turns?: number } | null;
  return {
    name,
    session,
    profile,
    status: task.status,
    offered: offeredData.names ?? [],
    priorMessages: offeredData.priorMessages ?? 0,
    turns,
    tools,
    correction: correction ? { sent: true, starved: correctionData?.starved === true, turns: correctionData?.turns ?? 0 } : null,
    maxTurns: offeredData.maxTurns ?? 0,
  };
}

async function instruct(harness: Harness, sessionId: string, prompt: string, profile: "desktop" | "code"): Promise<Task> {
  const task = await harness.submit(sessionId, prompt, { waitMs: 0, maxAttempts: 1, toolProfile: profile });
  const deadline = Date.now() + 120_000;
  const handled = new Set<string>();
  while (Date.now() < deadline) {
    const current = harness.db.getTask(task.id);
    if (!current) break;
    if (current.status === "waiting_approval") {
      for (const approval of harness.db.listApprovals(task.id)) {
        if (approval.status !== "pending" || handled.has(approval.id)) continue;
        handled.add(approval.id);
        const allowed = /^(desktop_|fs_|task_)/.test(approval.toolName) || approval.toolName === "shell_exec" || approval.toolName === "code_run";
        harness.approve(task.id, approval.id, allowed ? "approved" : "denied");
      }
    }
    if (current.status !== "queued" && current.status !== "running" && current.status !== "waiting_children" && current.status !== "waiting_approval") return current;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return harness.db.getTask(task.id) ?? task;
}

function writeDiagnosis(report: DiagnosisReport, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(report, null, 2);
  if (/sk-[A-Za-z0-9]{10,}|boat_[A-Za-z0-9_-]{8,}/.test(body)) throw new Error("report contains a secret");
  fs.writeFileSync(path.join(dir, "action-diagnosis.json"), `${body}\n`);
}

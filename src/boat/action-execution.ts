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
import { codeWriteRunTool } from "../tools/code-write.js";
import type { ToolHost } from "../tools/host.js";

interface Row {
  name: string;
  mode: "controlled" | "language";
  category: string;
  ok: boolean;
  status: string;
  evidence: string;
}

export interface ActionReport {
  createdAt: string;
  startedFrom: "aee60fc";
  mode: "live" | "skipped";
  performanceClaim: "none";
  publicReady: false;
  liveExecuted: boolean;
  sandboxId: string;
  deleted: boolean;
  rows: Row[];
  rates: Record<string, string>;
  totals: { durationMs: number; deepseekUsd: number; boatUsd: number };
  notes: string[];
}

export async function runActionExecution(input: {
  boatApiKey?: string;
  deepseekApiKey?: string;
  boatBaseUrl?: string;
  reportDir?: string;
  only?: Array<"desktop" | "code" | "desktop-phrase" | "code-phrase">;
}): Promise<ActionReport> {
  const report = empty();
  const dir = input.reportDir ?? "reports";
  const flush = () => writeReport(report, dir);
  if (!input.boatApiKey || !input.deepseekApiKey) {
    report.notes.push(!input.boatApiKey ? "BOAT_API_KEY is unset" : "DEEPSEEK_API_KEY is unset");
    flush();
    return report;
  }
  report.mode = "live";
  report.liveExecuted = true;
  const started = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-106-"));
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
  const user = harness.createUser("Action");
  let sandboxId = "";
  let deepseekUsd = 0;
  const over = () => Date.now() - started > 14 * 60_000;
  const want = (name: "desktop" | "code" | "desktop-phrase" | "code-phrase") => !input.only || input.only.includes(name);
  try {
    await manager.ensure(user.id);
    sandboxId = (await manager.describe(user.id)).sandboxId ?? "";
    report.sandboxId = sandboxId;
    const desk = await manager.editDesktopFile(user.id, "controlled-desk", "proof/controlled-desk.txt", "PHASE106-CONTROL-DESK");
    const deskStages = await manager.fileStages(user.id, "proof/controlled-desk.txt");
    const deskCat = deskStages.find((stage) => stage.stage === "cat")?.detail ?? "";
    report.rows.push({
      name: "controlled desktop",
      mode: "controlled",
      category: "desktop",
      ok: desk.ok && deskCat.includes("PHASE106-CONTROL-DESK") && desk.calls.includes("click") && desk.calls.includes("type_text"),
      status: "tool",
      evidence: `${desk.detail}; cat ${clip(deskCat)}`,
    });
    const codeTool = codeWriteRunTool({
      workspaceRoot: "/home/user/linco",
      signal: AbortSignal.timeout(30_000),
      files: { write: (relative, content) => manager.write(user.id, relative, content) },
      computer: { id: "boat", exec: (command) => manager.run(user.id, command.command, command.timeoutMs, command.signal) },
    } as ToolHost);
    const codeResult = await codeTool.execute("controlled-code", {
      path: "proof/controlled-code.mjs",
      source: "console.log('PHASE106-CONTROL-RUN')\n",
    });
    const codeText = JSON.stringify(codeResult);
    report.rows.push({
      name: "controlled code",
      mode: "controlled",
      category: "code",
      ok: !("isError" in (codeResult as object) && (codeResult as { isError?: boolean }).isError) && codeText.includes("PHASE106-CONTROL-RUN") && codeText.includes("exit 0"),
      status: "tool",
      evidence: clip(codeText),
    });
    flush();
    const controlledOk = report.rows.filter((row) => row.mode === "controlled").every((row) => row.ok);
    if (!controlledOk) {
      report.notes.push("Natural-language tasks stayed queued because a controlled tool did not verify.");
      flush();
      return report;
    }
    harness.start();
    const jobs: Array<() => Promise<number>> = [];
    if (want("desktop")) {
      for (let index = 1; index <= 10; index += 1) {
        const token = `PHASE106-TYPE-${index}`;
        const file = `proof/desk-${index}.txt`;
        jobs.push(() => ask(report, harness, manager, user.id, "desktop", `desktop ${index}`, `Masaüstünde nano ile ${file} dosyasına ${token} yaz ve kaydet. Kabuk kullanma.`));
      }
    }
    if (want("code")) {
      for (let index = 1; index <= 10; index += 1) {
        const token = `PHASE106-RUN-${index}`;
        const file = `proof/code-${index}.mjs`;
        jobs.push(() => ask(report, harness, manager, user.id, "code", `code ${index}`, `${file} kodunu yaz ve node ile çalıştır. console.log('${token}')`));
      }
    }
    const deskPhrases = [
      (token: string, file: string) => `On the desktop, type ${token} into ${file} and save.`,
      (token: string, file: string) => `Open the text editor and save ${token} in ${file}.`,
      (token: string, file: string) => `${file} dosyasını masaüstünde aç, ${token} yaz ve kaydet.`,
      (token: string, file: string) => `Use the desktop editor to write ${token} into ${file} and save the file.`,
      (token: string, file: string) => `Masaüstünde ${file} için nano aç. İçine ${token} yaz ve kaydet.`,
    ];
    const codePhrases = [
      (token: string, file: string) => `Write a node program ${file} that prints ${token} and run the script.`,
      (token: string, file: string) => `Create ${file} and execute the script. It should print ${token}.`,
      (token: string, file: string) => `${file} programını yazıp node ile çalıştır. console.log('${token}')`,
      (token: string, file: string) => `Run the program in ${file} after writing it. console.log('${token}')`,
      (token: string, file: string) => `Bir node script yaz: ${file}. Çalıştırınca ${token} yazsın.`,
    ];
    if (want("desktop-phrase")) {
      deskPhrases.forEach((phrase, index) => {
        const token = `PHASE106-PHRASE-D-${index + 1}`;
        const file = `proof/phrase-d-${index + 1}.txt`;
        jobs.push(() => ask(report, harness, manager, user.id, "desktop-phrase", `desktop phrase ${index + 1}`, phrase(token, file)));
      });
    }
    if (want("code-phrase")) {
      codePhrases.forEach((phrase, index) => {
        const token = `PHASE106-PHRASE-C-${index + 1}`;
        const file = `proof/phrase-c-${index + 1}.mjs`;
        jobs.push(() => ask(report, harness, manager, user.id, "code-phrase", `code phrase ${index + 1}`, phrase(token, file)));
      });
    }
    for (const job of jobs) {
      if (over() || deepseekUsd > 0.55) {
        report.notes.push(deepseekUsd > 0.55 ? "stopped under the DeepSeek cap" : "stopped inside the 16 minute subgroup");
        break;
      }
      try {
        deepseekUsd += await job();
      } catch (error) {
        report.rows.push({
          name: "interrupted",
          mode: "language",
          category: "run",
          ok: false,
          status: "error",
          evidence: error instanceof Error ? error.message : String(error),
        });
      }
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
    report.totals = { durationMs: Date.now() - started, deepseekUsd: round(deepseekUsd), boatUsd: round(boatUsd) };
    report.rates = rates(report.rows);
    report.notes.push("A language row counts only when the tool trace and an independent file or stdout read agree. The model status is not the proof.");
    report.notes.push("The live runner approves Boat tool calls so the matrix can finish. That approval is not the production user prompt.");
    report.notes.push("Public use stays NO-GO. The shell can still open browser.sock, and a metadata redirect is not a verified refusal.");
    flush();
  }
  return report;
}

async function ask(report: ActionReport, harness: Harness, manager: BoatSandboxManager, userId: string, category: string, name: string, prompt: string): Promise<number> {
  const session = harness.createSession(userId);
  const profile = category.startsWith("desktop") ? "desktop" : "code";
  const task = await instruct(harness, session.id, prompt, profile);
  const evidence = await prove(harness, manager, task, prompt);
  const cost = harness.db.usageSummary(task.id).costUsd;
  report.rows.push({
    name,
    mode: "language",
    category,
    ok: evidence.length > 0 && task.status === "succeeded",
    status: task.status,
    evidence: evidence || `status ${task.status}; tools ${toolNames(harness, task.id).join(",") || "none"}; failed ${failedNames(harness, task.id).join(",") || "none"}; offered ${offeredNames(harness, task.id).join(",") || "none"}`,
  });
  return cost;
}

async function prove(harness: Harness, manager: BoatSandboxManager, task: Task, prompt: string): Promise<string> {
  const names = toolNames(harness, task.id);
  const file = prompt.match(/proof\/[A-Za-z0-9._-]+\.(?:txt|mjs|js)/)?.[0] ?? "";
  const token = prompt.match(/PHASE106-[A-Z0-9-]+/)?.[0] ?? "";
  if (file.endsWith(".txt")) {
    const stages = await manager.fileStages(task.userId, file);
    const cat = stages.find((stage) => stage.stage === "cat");
    const edited = names.includes("desktop_edit_file") || (names.includes("desktop_click") && names.includes("desktop_type"));
    return edited && Boolean(cat?.detail.includes(token)) ? `tools ${names.join(",")}; cat ${clip(cat?.detail ?? "")}` : "";
  }
  const stages = await manager.fileStages(task.userId, file);
  const source = stages.find((stage) => stage.stage === "cat")?.detail ?? "";
  const traces = harness.db.listTraces(task.id);
  const args = new Map<string, string>();
  for (const trace of traces) {
    if (trace.kind !== "tool") continue;
    const data = trace.data as { phase?: string; toolCallId?: string; args?: string };
    if (data.phase === "start" && data.toolCallId) args.set(data.toolCallId, data.args ?? "");
  }
  const base = file.split("/").pop() ?? file;
  const ran = traces.some((trace) => {
    if (trace.kind !== "tool" || (trace.name !== "code_write_run" && trace.name !== "shell_exec")) return false;
    const data = trace.data as { phase?: string; isError?: boolean; result?: string; toolCallId?: string };
    if (data.phase !== "end" || data.isError) return false;
    const blob = `${args.get(data.toolCallId ?? "") ?? ""} ${data.result ?? ""}`;
    return blob.includes(token) && blob.includes(base);
  });
  return ran && source.includes(token) ? `tools ${names.join(",")}; source and stdout have the token` : "";
}

async function instruct(harness: Harness, sessionId: string, prompt: string, profile: "desktop" | "code"): Promise<Task> {
  const task = await harness.submit(sessionId, prompt, { waitMs: 0, maxAttempts: 1, toolProfile: profile });
  const deadline = Date.now() + 90_000;
  const handled = new Set<string>();
  while (Date.now() < deadline) {
    const current = harness.db.getTask(task.id);
    if (!current) break;
    if (current.status === "waiting_approval") {
      for (const approval of harness.db.listApprovals(task.id)) {
        if (approval.status !== "pending" || handled.has(approval.id)) continue;
        handled.add(approval.id);
        const allowed = /^(desktop_|fs_|task_)/.test(approval.toolName) || approval.toolName === "shell_exec" || approval.toolName === "code_run" || approval.toolName === "code_write_run";
        harness.approve(task.id, approval.id, allowed ? "approved" : "denied");
      }
    }
    if (current.status !== "queued" && current.status !== "running" && current.status !== "waiting_children" && current.status !== "waiting_approval") return current;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  harness.cancel(task.id);
  return harness.db.getTask(task.id) ?? task;
}

function offeredNames(harness: Harness, taskId: string): string[] {
  const trace = harness.db.listTraces(taskId).find((item) => item.kind === "model" && item.name === "tools");
  const names = (trace?.data as { names?: string[] } | undefined)?.names;
  return Array.isArray(names) ? names : [];
}

function failedNames(harness: Harness, taskId: string): string[] {
  const names: string[] = [];
  for (const trace of harness.db.listTraces(taskId)) {
    if (trace.kind !== "tool") continue;
    const data = trace.data as { phase?: string; isError?: boolean };
    if (data.phase === "end" && data.isError) names.push(trace.name);
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

function empty(): ActionReport {
  return {
    createdAt: new Date().toISOString(),
    startedFrom: "aee60fc",
    mode: "skipped",
    performanceClaim: "none",
    publicReady: false,
    liveExecuted: false,
    sandboxId: "",
    deleted: false,
    rows: [],
    rates: {},
    totals: { durationMs: 0, deepseekUsd: 0, boatUsd: 0 },
    notes: [],
  };
}

function rates(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const category of ["desktop", "code", "desktop-phrase", "code-phrase"]) {
    const group = rows.filter((row) => row.category === category && row.mode === "language");
    if (group.length === 0) continue;
    out[category] = `${group.filter((row) => row.ok).length}/${group.length}`;
  }
  return out;
}

function writeReport(report: ActionReport, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(report, null, 2);
  if (/sk-[A-Za-z0-9]{10,}|boat_[A-Za-z0-9_-]{8,}/.test(body)) throw new Error("report contains a secret");
  fs.writeFileSync(path.join(dir, "action-execution.json"), `${body}\n`);
  const lines = [
    "# Action execution",
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
    "## Notes",
    "",
    ...report.notes.map((item) => `- ${item}`),
    "",
  ];
  fs.writeFileSync(path.join(dir, "action-execution.md"), lines.join("\n"));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clip(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

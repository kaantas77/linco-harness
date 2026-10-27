import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Harness } from "../agent/runtime.js";
import { redactSecrets } from "../bench/types.js";
import { loadConfig } from "../config.js";
import { LincoDb } from "../db/database.js";
import { createDeepSeek } from "../llm/deepseek.js";
import type { Task } from "../types.js";
import { createBoatClient, type BoatClient, type DesktopObservation } from "./client.js";
import { openVerifiedPage, readWindows, typeIntoEditor, type DriverCaller } from "./desktop-flow.js";
import { LIVE_LIMITS } from "./live-check.js";
import { inspectPng, labelPng } from "./label-png.js";
import { BoatSandboxManager } from "./manager.js";
import { redactBoat } from "./redact.js";
import { quotedCode, readPaintedCode, readPaintedCodeDirect } from "./vision-read.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TYPE_TEXT = "PHASE102-TYPE";
const FORM_TEXT = "PHASE102-FORM";

export interface V2Step {
  name: string;
  ok: boolean;
  durationMs: number;
  toolCalls: string[];
  deepseekUsd: number;
  evidence: string;
}

export interface V2Vision {
  path: "original-omit" | "original-high" | "desktop" | "cua-tool";
  code: string;
  ok: boolean;
  width: number;
  height: number;
  bytes: number;
  dark: number;
  decoded: boolean;
  detail: string;
  reply: string;
  deepseekUsd: number;
  evidence: string;
}

export interface ComputerUseV2Report {
  createdAt: string;
  startedFrom: "8712a8f";
  mode: "live";
  performanceClaim: "none";
  liveExecuted: boolean;
  liveReason: string;
  limits: typeof LIVE_LIMITS;
  sandboxId: string | null;
  deleted: boolean;
  cuaProbe: { ok: boolean; detail: string; calls: string[] };
  atspi: string;
  browserEngine: string;
  controlled: V2Step[];
  vision: V2Vision[];
  naturalLanguage: V2Step[];
  totals: { durationMs: number; deepseekUsd: number; boatUsd: number };
  notes: string[];
}

export async function runComputerUseV2(input: {
  boatApiKey?: string;
  deepseekApiKey?: string;
  boatBaseUrl?: string;
  reportDir?: string;
}): Promise<ComputerUseV2Report> {
  const report = emptyReport();
  const flush = () => writeReport(report, input.reportDir ?? "reports");
  if (!input.boatApiKey || !input.deepseekApiKey) {
    report.liveReason = !input.boatApiKey ? "BOAT_API_KEY is unset" : "DEEPSEEK_API_KEY is unset";
    report.notes.push("No live success is claimed. The Boat VM was not created.");
    flush();
    return report;
  }
  report.liveExecuted = true;
  report.liveReason = "Railway variables were injected for this process. Values were not written to the report.";
  const started = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-computer-use-v2-"));
  const managerDb = new LincoDb(path.join(root, "linco.sqlite"));
  const watched = watchClient(createBoatClient({ apiKey: input.boatApiKey, basePath: input.boatBaseUrl }));
  const manager = new BoatSandboxManager({
    client: watched.client,
    db: managerDb,
    machineType: LIVE_LIMITS.machineType,
    ttlSeconds: LIVE_LIMITS.ttlSeconds,
    idleStopMs: 60 * 60_000,
    maxSeconds: LIVE_LIMITS.maxSeconds,
    readyTimeoutMs: LIVE_LIMITS.readyTimeoutMs,
  });
  let sandboxId = "";
  let userId = "";
  let blocked = "";
  const boatUsd = async () => (userId ? (await manager.describe(userId)).usage?.dollars ?? 0 : 0);
  const overCap = async () => {
    if (blocked) return blocked;
    if (Date.now() - started > 18 * 60_000) blocked = "stopped before the 1500s sandbox lifetime";
    const spent = await boatUsd().catch(() => 0);
    const deepseek = totalDeepseek(report);
    if (spent >= LIVE_LIMITS.boatUsd) blocked = `boat usage ${spent} reached the ${LIVE_LIMITS.boatUsd} dollar cap`;
    else if (deepseek >= LIVE_LIMITS.deepseekUsd) blocked = `deepseek usage ${deepseek} reached the ${LIVE_LIMITS.deepseekUsd} dollar cap`;
    return blocked;
  };
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
  const languageUser = harness.createUser("Live");
  const languageSession = harness.createSession(languageUser.id);
  try {
    userId = languageUser.id;
    await manager.ensure(userId);
    sandboxId = (await manager.describe(userId)).sandboxId ?? "";
    report.sandboxId = sandboxId;
    const driver: DriverCaller = {
      call: (tool, args) => manager.desktop(userId, `flow-${tool}`, tool, args),
      schema: (name) => manager.schema(name),
    };
    const atspi = await manager.run(
      userId,
      "echo DISPLAY=${DISPLAY:-missing}; echo DBUS=${DBUS_SESSION_BUS_ADDRESS:-missing}; (gdbus introspect --session --dest org.a11y.Bus --object-path /org/a11y/bus 2>&1 || true) | head -n 12; (ps -ef | grep -E 'at-spi|chrome|chromium' | grep -v grep || true) | head -n 12",
      20_000,
    );
    report.atspi = clip(atspi.stdout || atspi.stderr);
    if (/a11y/.test(report.atspi)) {
      report.notes.push("gdbus reached the accessibility bus while DBUS_SESSION_BUS_ADDRESS was unset in that command. Cua can still refuse the existing Chromium window.");
    }

    await step(report.controlled, "cua-chrome", async () => {
      const opened = await openVerifiedPage(driver, "https://example.com", /Example Domain/i);
      const windows = await driver.call("list_windows", {}).catch((error) => ({ text: errorText(error), tree: "" }));
      const titles = readWindows(windows.text).map((item) => item.title).join(" | ");
      const verified = opened.ok && /Example Domain/i.test(`${titles}\n${windows.text}`);
      report.cuaProbe = { ok: verified, detail: `${opened.kind}; ${opened.detail}; titles ${titles}`, calls: opened.calls };
      return { ok: verified, toolCalls: opened.calls, deepseekUsd: 0, evidence: report.cuaProbe.detail };
    });
    flush();

    await step(report.controlled, "example", async () => {
      const opened = await manager.browserAct(languageUser.id, "example", { op: "goto", url: "https://example.com" });
      const again = await manager.browserAct(languageUser.id, "example-read", { op: "read" });
      report.browserEngine = opened.engine || again.engine || "";
      const ok = opened.title === "Example Domain" && again.title === "Example Domain";
      return {
        ok,
        toolCalls: ["vm_browser_goto", "vm_browser_read"],
        deepseekUsd: 0,
        evidence: `engine ${opened.engine}; first title ${JSON.stringify(opened.title)}; second title ${JSON.stringify(again.title)}; url ${opened.url ?? ""}`,
      };
    });
    flush();

    await step(report.controlled, "form", async () => {
      const filled = await manager.browserAct(languageUser.id, "form", {
        op: "fill",
        url: "https://httpbin.org/forms/post",
        name: "custname",
        text: FORM_TEXT,
        submit: true,
      });
      const ok = (filled.text ?? "").includes(FORM_TEXT);
      return {
        ok,
        toolCalls: ["vm_browser_fill"],
        deepseekUsd: 0,
        evidence: `engine ${filled.engine}; url ${filled.url ?? ""}; body contains the value ${ok}; title ${JSON.stringify(filled.title)}`,
      };
    });
    flush();

    await step(report.controlled, "typing", async () => {
      await manager.remove(userId, "proof/typed.txt").catch(() => undefined);
      await manager.run(
        userId,
        "mkdir -p /home/user/linco/proof && : > /home/user/linco/proof/typed.txt; pkill -f 'nano /home/user/linco/proof/typed.txt' >/dev/null 2>&1 || true; DISPLAY=${DISPLAY:-:0} nohup sh -c 'if command -v gnome-terminal >/dev/null; then gnome-terminal -- nano /home/user/linco/proof/typed.txt; elif command -v x-terminal-emulator >/dev/null; then x-terminal-emulator -e nano /home/user/linco/proof/typed.txt; elif command -v xterm >/dev/null; then xterm -e nano /home/user/linco/proof/typed.txt; fi' >/tmp/nano.log 2>&1 & exit 0",
        15_000,
      );
      await sleep(1200);
      const typed = await typeIntoEditor(driver, "/home/user/linco/proof/typed.txt", TYPE_TEXT);
      const read = await proveFile(manager, userId, "proof/typed.txt");
      const matched = read.trim() === TYPE_TEXT;
      const usedDesktop = typed.calls.includes("click") && typed.calls.includes("type_text");
      return {
        ok: typed.ok && matched && usedDesktop,
        toolCalls: typed.calls,
        deepseekUsd: 0,
        evidence: `click ${typed.calls.includes("click")}; type_text ${typed.calls.includes("type_text")}; shell wrote the content: no; independent read ${JSON.stringify(clip(read))}; trim matched ${matched}; driver ${typed.kind} ${typed.detail}`,
      };
    });
    flush();

    const codes = [paintCode(), paintCode(), paintCode()];
    for (const [index, code] of codes.entries()) {
      if (await overCap()) {
        report.vision.push(emptyVision("original-high", code, blocked));
        continue;
      }
      const png = labelPng(code, 48);
      const info = inspectPng(png);
      for (const detail of ["omit", "high"] as const) {
        const pathName = detail === "omit" ? "original-omit" : "original-high";
        try {
          const read = await readPaintedCodeDirect(input.deepseekApiKey, png, detail);
          const reply = read.text || "";
          report.vision.push({
            path: pathName,
            code,
            ok: quotedCode(reply, code) && info.decoded && info.dark >= 20,
            width: info.width,
            height: info.height,
            bytes: read.bytes,
            dark: info.dark,
            decoded: info.decoded,
            detail,
            reply: clip(reply),
            deepseekUsd: read.costUsd,
            evidence: reply ? "original png sent directly; thinking disabled; no desktop and no tool result" : `empty content; reasoning ${clip(read.reasoning)}`,
          });
        } catch (error) {
          report.vision.push({ ...emptyVision(pathName, code, errorText(error)), width: info.width, height: info.height, dark: info.dark, decoded: info.decoded, bytes: png.toString("base64").length, detail });
        }
      }
      flush();
      if (await overCap()) continue;
      await desktopVision(report, manager, userId, input.deepseekApiKey, driver, code, index);
      flush();
    }

    await step(report.controlled, "shared-vm", async () => {
      const hold = manager.browserAct(userId, "hold-a", { op: "hold" });
      await sleep(500);
      let lock = "";
      try {
        await manager.desktop(userId, "hold-b", "get_desktop_state", {});
        lock = "second task was not blocked";
      } catch (error) {
        lock = errorText(error);
      }
      let holdError = "";
      await hold.catch((error) => {
        holdError = errorText(error);
      });
      await manager.write(userId, "proof/shared.txt", "PHASE102-SHARED");
      const shared = (await manager.read(userId, "proof/shared.txt")).text;
      const ok = /desktop is in use/.test(lock) && holdError === "" && shared === "PHASE102-SHARED" && watched.counts.create === 1;
      return { ok, toolCalls: ["browser-hold", "desktop", "write", "read"], deepseekUsd: 0, evidence: `lock ${clip(lock)}; hold ${holdError ? clip(holdError) : "ok"}; file ${JSON.stringify(shared)}; creates ${watched.counts.create}` };
    });
    flush();

    if (!(await overCap())) await runLanguage(report, harness, languageSession.id, manager, userId, overCap);
  } catch (error) {
    report.notes.push(`run stopped: ${clip(redact(errorText(error)))}`);
  } finally {
    const spentBoat = await boatUsd().catch(() => 0);
    flush();
    if (userId && sandboxId) {
      try {
        await manager.stop(userId);
      } catch (error) {
        report.notes.push(`stop failed: ${clip(redact(errorText(error)))}`);
      }
      try {
        await watched.client.delete(sandboxId);
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
      deepseekUsd: totalDeepseek(report),
      boatUsd: spentBoat,
    };
    flush();
  }
  return report;
}

export function renderComputerUseV2Markdown(report: ComputerUseV2Report): string {
  const visionRate = (pathName: V2Vision["path"]) => {
    const rows = report.vision.filter((item) => item.path === pathName);
    const ok = rows.filter((item) => item.ok).length;
    return `${ok}/${rows.length}`;
  };
  const lines = [
    "# Computer use v2",
    "",
    "Mode: live. Performance claim: none. This is not a ranking and not a bill.",
    "",
    report.liveExecuted ? report.liveReason : `Live run did not start. ${report.liveReason}`,
    "",
    "Started from commit 8712a8f.",
    `Limits set before the run: ${report.limits.machineType}, ttl ${report.limits.ttlSeconds}s, max ${report.limits.maxSeconds}s, boat $${report.limits.boatUsd}, deepseek $${report.limits.deepseekUsd}.`,
    `Sandbox: ${report.sandboxId ?? "none"}. Deleted: ${report.deleted ? "yes" : "no"}.`,
    `Browser engine inside the VM: ${report.browserEngine || "none"}.`,
    `Cua existing-profile probe ok: ${report.cuaProbe.ok ? "yes" : "no"}. ${report.cuaProbe.detail}`,
    `AT-SPI: ${report.atspi || "not collected"}`,
    `Original PNG detail omitted ${visionRate("original-omit")}. Original PNG detail high ${visionRate("original-high")}. Desktop screenshot ${visionRate("desktop")}. Cua screenshot through the Pi image path ${visionRate("cua-tool")}.`,
    `Totals: ${report.totals.durationMs} ms, deepseek $${report.totals.deepseekUsd.toFixed(6)}, boat $${report.totals.boatUsd.toFixed(6)}.`,
    "",
    "## Controlled tool flow",
    "",
    "| name | ok | ms | tools | deepseek usd | evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.controlled.map(stepRow),
    "",
    "## Vision paths",
    "",
    "| path | code | ok | px | bytes | dark | decoded | detail | reply | deepseek usd | evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.vision.map((item) => `| ${item.path} | ${item.code} | ${item.ok ? "yes" : "no"} | ${item.width}x${item.height} | ${item.bytes} | ${item.dark} | ${item.decoded ? "yes" : "no"} | ${item.detail} | ${item.reply.replaceAll("|", "/")} | ${item.deepseekUsd.toFixed(6)} | ${item.evidence.replaceAll("|", "/")} |`),
    "",
    "## Natural language",
    "",
    "These rows are separate from the controlled flow. A model status is not evidence.",
    "",
    "| name | ok | ms | tools | deepseek usd | evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.naturalLanguage.map(stepRow),
    "",
    ...report.notes.map((note) => `- ${note}`),
    "",
  ];
  return lines.join("\n");
}

async function desktopVision(
  report: ComputerUseV2Report,
  manager: BoatSandboxManager,
  userId: string,
  apiKey: string,
  driver: DriverCaller,
  code: string,
  index: number,
): Promise<void> {
  const png = labelPng(code, 48);
  const relative = `proof/label-${index}.b64`;
  try {
    await manager.write(userId, relative, png.toString("base64"));
    const shown = await manager.browserAct(userId, `show-${index}`, { op: "showFile", relative });
    const grab = await manager.browserAct(userId, `grab-${index}`, { op: "grab" });
    if (!grab.shot) throw new Error("desktop grab did not return a file");
    const shot = Buffer.from((await manager.read(userId, grab.shot)).text, "base64");
    const info = inspectPng(shot);
    const read = await readPaintedCodeDirect(apiKey, shot, "high");
    const leaked = (shown.text ?? "").includes(code);
    report.vision.push({
      path: "desktop",
      code,
      ok: quotedCode(read.text, code) && info.decoded && info.dark >= 20 && !leaked,
      width: info.width,
      height: info.height,
      bytes: read.bytes,
      dark: info.dark,
      decoded: info.decoded,
      detail: "high",
      reply: clip(read.text),
      deepseekUsd: read.costUsd,
      evidence: `capture ${grab.captureTool ?? "none"}; window title ${JSON.stringify(shown.title)}; page bytes ${shown.bytes ?? 0}; ${read.text ? "content" : `empty content; reasoning ${clip(read.reasoning)}`}`,
    });
  } catch (error) {
    report.vision.push(emptyVision("desktop", code, errorText(error)));
  }
  try {
    const listed = await driver.call("list_windows", {});
    const windows = readWindows(listed.text);
    const match = windows.find((item) => /label/i.test(item.title) && item.pid && item.windowId)
      ?? windows.find((item) => /chrome|chromium/i.test(item.title) && item.pid && item.windowId);
    if (!match?.pid || !match.windowId) {
      report.vision.push({ ...emptyVision("cua-tool", code, `window not found ${clip(listed.text)}`), evidence: clip(listed.text) });
      return;
    }
    const shot = await driver.call("get_window_state", { pid: match.pid, window_id: match.windowId, include_screenshot: true });
    const image = imageOf(shot);
    if (!image) {
      report.vision.push(emptyVision("cua-tool", code, "cua returned no image"));
      return;
    }
    const info = inspectPng(image);
    const leaked = `${shot.text}\n${shot.tree}`.includes(code);
    const read = await readPaintedCode(apiKey, image);
    report.vision.push({
      path: "cua-tool",
      code,
      ok: quotedCode(read.text, code) && info.decoded && info.dark >= 20 && !leaked,
      width: info.width,
      height: info.height,
      bytes: read.bytes,
      dark: info.dark,
      decoded: info.decoded,
      detail: "pi-default",
      reply: clip(read.text),
      deepseekUsd: read.costUsd,
      evidence: `window ${JSON.stringify(match.title)} ${info.width}x${info.height}; tree leaked ${leaked}; sent through Pi image content`,
    });
  } catch (error) {
    report.vision.push(emptyVision("cua-tool", code, errorText(error)));
  }
}

async function runLanguage(
  report: ComputerUseV2Report,
  harness: Harness,
  sessionId: string,
  manager: BoatSandboxManager,
  userId: string,
  overCap: () => Promise<string>,
): Promise<void> {
  const taskIds: string[] = [];
  const spent = () => [...new Set(taskIds)].reduce((sum, id) => sum + harness.db.usageSummary(id).costUsd, 0);
  try {
    harness.start();
    const ask = async (name: string, prompt: string, check: (task: Task) => Promise<{ ok: boolean; evidence: string }>) => {
      const reason = await overCap();
      if (reason) {
        report.naturalLanguage.push({ name, ok: false, durationMs: 0, toolCalls: [], deepseekUsd: 0, evidence: `skipped: ${reason}` });
        return;
      }
      await step(report.naturalLanguage, name, async () => {
        const before = spent();
        const task = await instruct(harness, sessionId, prompt);
        taskIds.push(task.id);
        const names = toolNames(harness, task.id);
        const checked = await check(task);
        return { ...checked, toolCalls: names, deepseekUsd: spent() - before };
      });
    };
    await ask( "example", "Use vm_browser_goto to open https://example.com on the Boat computer. Do not use the host. Stop after the tool result shows the title.", async (task) => {
      const names = toolNames(harness, task.id);
      const used = names.includes("vm_browser_goto");
      const page = await manager.browserAct(userId, "nl-example", { op: "read" }).catch((error) => ({ title: "", text: errorText(error) }));
      const verified = page.title === "Example Domain";
      return { ok: used && verified, evidence: `status ${task.status}; tool ${used}; independent title ${JSON.stringify(page.title)}; quote ${clip(task.resultText ?? "")}` };
    });
    await ask("typing", "On the Boat desktop, click the open nano window, type PHASE102-TYPE, and save the file with the editor. Do not write the file with the shell. Use desktop_click and desktop_type.", async (task) => {
      const names = toolNames(harness, task.id);
      const read = await proveFile(manager, userId, "proof/typed.txt");
      const clicked = names.includes("desktop_click");
      const typed = names.includes("desktop_type");
      const shell = names.includes("shell_exec") || names.includes("code_run");
      return { ok: read.trim() === TYPE_TEXT && clicked && typed && !shell, evidence: `status ${task.status}; click ${clicked}; type ${typed}; shell ${shell}; independent read ${JSON.stringify(clip(read))}` };
    });
  } finally {
    await harness.stop().catch(() => undefined);
  }
}

async function step(
  bucket: V2Step[],
  name: string,
  fn: () => Promise<{ ok: boolean; toolCalls: string[]; deepseekUsd: number; evidence: string }>,
): Promise<void> {
  const started = Date.now();
  try {
    const result = await fn();
    bucket.push({ name, ok: result.ok, durationMs: Date.now() - started, toolCalls: result.toolCalls, deepseekUsd: result.deepseekUsd, evidence: clip(redact(result.evidence)) });
  } catch (error) {
    bucket.push({ name, ok: false, durationMs: Date.now() - started, toolCalls: [], deepseekUsd: 0, evidence: clip(redact(errorText(error))) });
  }
}

function emptyReport(): ComputerUseV2Report {
  return {
    createdAt: new Date().toISOString(),
    startedFrom: "8712a8f",
    mode: "live",
    performanceClaim: "none",
    liveExecuted: false,
    liveReason: "",
    limits: LIVE_LIMITS,
    sandboxId: null,
    deleted: false,
    cuaProbe: { ok: false, detail: "", calls: [] },
    atspi: "",
    browserEngine: "",
    controlled: [],
    vision: [],
    naturalLanguage: [],
    totals: { durationMs: 0, deepseekUsd: 0, boatUsd: 0 },
    notes: [
      "The agent model stays DeepSeek Flash. detail high is a measurement request, not a model change.",
      "No second vision model was called.",
      "A browser action runs only as a command inside the user's Boat VM.",
      "The Cua probe is one row. A refusal is not the example.com result, and one success is not a five-trial rate.",
      "A deleted sandbox, bx_ek9jw5yf, never started Chrome: the serve command contained `&;` and bash rejected it. Direct vision calls on that run returned empty content because thinking was left on and max_tokens was 64.",
      "The published engine is cdp: playwright-core was not imported, and the isolated Chrome on the VM desktop was driven through 127.0.0.1.",
    ],
  };
}

function emptyVision(pathName: V2Vision["path"], code: string, evidence: string): V2Vision {
  return { path: pathName, code, ok: false, width: 0, height: 0, bytes: 0, dark: 0, decoded: false, detail: "", reply: "", deepseekUsd: 0, evidence: clip(redact(evidence)) };
}

function writeReport(report: ComputerUseV2Report, directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "computer-use-v2.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, "computer-use-v2.md"), renderComputerUseV2Markdown(report));
}

function stepRow(item: V2Step): string {
  return `| ${item.name} | ${item.ok ? "yes" : "no"} | ${item.durationMs} | ${item.toolCalls.join(", ") || "none"} | ${item.deepseekUsd.toFixed(6)} | ${item.evidence.replaceAll("|", "/")} |`;
}

function totalDeepseek(report: ComputerUseV2Report): number {
  return [...report.controlled, ...report.naturalLanguage].reduce((sum, item) => sum + item.deepseekUsd, 0)
    + report.vision.reduce((sum, item) => sum + item.deepseekUsd, 0);
}

function imageOf(observation: DesktopObservation): Buffer | undefined {
  if (!observation.image?.data) return undefined;
  return Buffer.from(observation.image.data, "base64");
}

function paintCode(): string {
  return Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)] ?? "A").join("");
}

async function proveFile(manager: BoatSandboxManager, userId: string, relativePath: string): Promise<string> {
  try {
    return (await manager.read(userId, relativePath)).text;
  } catch (error) {
    const via = await manager.run(userId, `cat /home/user/linco/${relativePath}`, 15_000).catch(() => ({ stdout: "", stderr: errorText(error), exitCode: 1 }));
    if (via.exitCode === 0) return via.stdout;
    return `READ FAILED ${errorText(error)}; cat ${via.stderr || via.stdout}`;
  }
}

async function instruct(harness: Harness, sessionId: string, prompt: string): Promise<Task> {
  const task = await harness.submit(sessionId, prompt, { waitMs: 0, maxAttempts: 1 });
  const deadline = Date.now() + 180_000;
  const handled = new Set<string>();
  while (Date.now() < deadline) {
    const current = harness.db.getTask(task.id);
    if (!current) break;
    if (current.status === "waiting_approval") {
      for (const approval of harness.db.listApprovals(task.id)) {
        if (approval.status !== "pending" || handled.has(approval.id)) continue;
        handled.add(approval.id);
        const allowed = approval.toolName.startsWith("desktop_") || approval.toolName.startsWith("vm_browser_");
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
    const data = trace.data as { phase?: string; isError?: boolean };
    if (data.phase !== "end") continue;
    names.push(data.isError ? `${trace.name}!` : trace.name);
  }
  return names;
}

function watchClient(inner: BoatClient): { client: BoatClient; counts: { create: number } } {
  const counts = { create: 0 };
  return {
    counts,
    client: {
      create: async (input) => {
        counts.create += 1;
        return inner.create(input);
      },
      get: (id) => inner.get(id),
      stop: (id) => inner.stop(id),
      resume: (id) => inner.resume(id),
      delete: (id) => inner.delete(id),
      command: (input) => inner.command(input),
      readText: (id, file) => inner.readText(id, file),
      writeText: (id, file, content) => inner.writeText(id, file, content),
      list: (id, file) => inner.list(id, file),
      usage: (id) => inner.usage(id),
      latestSnapshot: (id) => inner.latestSnapshot(id),
      desktop: (id, tool, args) => inner.desktop(id, tool, args),
    },
  };
}

function redact(text: string): string {
  return redactSecrets(redactBoat(text));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function vmBrowserScriptChecked(): { ok: boolean; detail: string } {
  const script = fs.readFileSync(path.resolve("src/boat/vm-browser.mjs"), "utf8");
  const checked = spawnSync(process.execPath, ["--check", path.resolve("src/boat/vm-browser.mjs")], { encoding: "utf8" });
  const problems = [
    script.includes("playwright-core") ? "" : "missing playwright",
    script.includes("/home/user/linco/.linco/chrome-profile") ? "" : "missing profile",
    script.includes("127.0.0.1") ? "" : "missing loopback bind",
    script.includes("--headless") ? "headless flag is present" : "",
    script.includes("/Users") ? "host home is present" : "",
    checked.status === 0 ? "" : checked.stderr,
  ].filter(Boolean);
  return { ok: problems.length === 0, detail: problems.join("; ") || "syntax ok" };
}

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
import { createBoatClient, type BoatClient } from "./client.js";
import { captureViewer, openVerifiedPage, readWindows, typeIntoEditor, type DriverCaller } from "./desktop-flow.js";
import { LIVE_LIMITS } from "./live-check.js";
import { inspectPng, labelPng } from "./label-png.js";
import { BoatSandboxManager } from "./manager.js";
import { quoteShell } from "./paths.js";
import { redactBoat } from "./redact.js";
import { quotedCode, readPaintedCode } from "./vision-read.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TYPE_TEXT = "PHASE10-TYPE";
const TRIALS = 5;

export interface ComputerUseTrial {
  n: number;
  ok: boolean;
  durationMs: number;
  toolCalls: string[];
  errors: number;
  retries: number;
  deepseekUsd: number;
  boatUsd: number;
  evidence: string;
}

export interface ComputerUseReport {
  createdAt: string;
  startedFrom: "2f8675b";
  mode: "live";
  performanceClaim: "none";
  liveExecuted: boolean;
  liveReason: string;
  limits: typeof LIVE_LIMITS;
  sandboxId: string | null;
  deleted: boolean;
  protocol: "json-lines";
  driverErrorCheck: "isError and error content fail the tool call";
  schemas: Array<{ name: string; required: string[]; properties: string[] }>;
  kept: ComputerUseTrial[];
  chrome: ComputerUseTrial[];
  typing: ComputerUseTrial[];
  vision: ComputerUseTrial[];
  naturalLanguage: ComputerUseTrial[];
  totals: { durationMs: number; deepseekUsd: number; boatUsd: number };
  notes: string[];
}

export async function runComputerUse(input: {
  boatApiKey?: string;
  deepseekApiKey?: string;
  boatBaseUrl?: string;
  reportDir?: string;
}): Promise<ComputerUseReport> {
  const report = emptyReport();
  const flush = () => writeReport(report, input.reportDir ?? "reports");
  if (!input.boatApiKey || !input.deepseekApiKey) {
    report.liveReason = !input.boatApiKey ? "BOAT_API_KEY is unset" : "DEEPSEEK_API_KEY is unset";
    report.notes.push("No live success is claimed. The three scenarios were not run.");
    flush();
    return report;
  }
  report.liveExecuted = true;
  report.liveReason = "Railway variables were injected for this process. Values were not written to the report.";
  const started = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-computer-use-"));
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
    const described = await manager.describe(userId);
    sandboxId = described.sandboxId ?? "";
    report.sandboxId = sandboxId;
    const driver: DriverCaller = {
      call: (tool, args) => manager.desktop(userId, `flow-${tool}`, tool, args),
      schema: (name) => manager.schema(name),
    };
    await trial(report.kept, 1, async () => {
      await manager.write(userId, "proof/hello.txt", "PHASE10-FILE");
      const text = (await manager.read(userId, "proof/hello.txt")).text;
      const ran = await manager.run(userId, "node -e \"console.log('PHASE10-RUN')\"", 20_000);
      const ok = text === "PHASE10-FILE" && ran.stdout.trim() === "PHASE10-RUN" && ran.exitCode === 0;
      return { ok, toolCalls: ["write", "read", "command"], errors: ok ? 0 : 1, retries: 0, deepseekUsd: 0, evidence: `file ${JSON.stringify(text)}; stdout ${JSON.stringify(ran.stdout.trim())}` };
    }, boatUsd);
    await driver.call("tools/list", {});
    report.schemas = manager.schemasSnapshot().map((schema) => ({ name: schema.name, required: schema.required, properties: schema.properties }));
    report.notes.push(`tools/list returned ${report.schemas.length} schemas. Arguments are checked against that list before the driver call.`);
    const installed = await manager.run(
      userId,
      "ls /usr/share/applications 2>/dev/null | grep -Ei 'chrom|text|edit|gedit|writer|nano|eog|image|code|mouse|terminal' || true; echo ---; command -v chromium chromium-browser google-chrome gnome-text-editor gedit nano gnome-terminal xterm 2>/dev/null || true",
      20_000,
    );
    report.notes.push(`installed desktop apps: ${installed.stdout.replace(/\s+/g, " ").slice(0, 900)}`);

    for (let n = 1; n <= TRIALS; n += 1) {
      if (await overCap()) {
        report.chrome.push(skipped(n, blocked));
        continue;
      }
      await trial(report.chrome, n, async () => {
        const opened = await openVerifiedPage(driver, "https://example.com", /Example Domain/i);
        const windows = await driver.call("list_windows", {}).catch((error) => ({ text: errorText(error), tree: "" }));
        const titles = readWindows(windows.text).map((window) => window.title).join(" | ");
        const verified = opened.ok && /Example Domain/i.test(`${titles}\n${windows.text}`);
        return {
          ok: opened.ok && verified,
          toolCalls: [...opened.calls, "list_windows"],
          errors: opened.ok && verified ? 0 : 1,
          retries: opened.retries,
          deepseekUsd: 0,
          evidence: `${opened.kind}; flow ${opened.detail}; window titles ${clip(titles)}; title verified ${verified}`,
        };
      }, boatUsd);
      flush();
    }

    for (let n = 1; n <= TRIALS; n += 1) {
      if (await overCap()) {
        report.typing.push(skipped(n, blocked));
        continue;
      }
      await trial(report.typing, n, async () => {
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
          errors: matched && usedDesktop ? 0 : 1,
          retries: typed.retries,
          deepseekUsd: 0,
          evidence: `click ${typed.calls.includes("click")}; type_text ${typed.calls.includes("type_text")}; shell wrote the content: no; independent read ${JSON.stringify(clip(read))}; driver ${typed.kind} ${typed.detail}`,
        };
      }, boatUsd);
      flush();
    }

    for (let n = 1; n <= TRIALS; n += 1) {
      if (await overCap()) {
        report.vision.push(skipped(n, blocked));
        continue;
      }
      await trial(report.vision, n, async () => {
        const code = ALPHABET[randomInt(ALPHABET.length)]! + ALPHABET[randomInt(ALPHABET.length)]! + ALPHABET[randomInt(ALPHABET.length)]! + ALPHABET[randomInt(ALPHABET.length)]!;
        const png = labelPng(code, 48);
        const file = `shot-${n}.png`;
        const written = await manager.run(
          userId,
          `mkdir -p /home/user/linco/proof && printf %s ${quoteShell(png.toString("base64"))} | base64 -d > /home/user/linco/proof/${file}`,
          20_000,
        );
        const shot = await captureViewer(driver, file, `/home/user/linco/proof/${file}`);
        const leaked = (shot.tree ?? "").includes(code);
        if (!shot.ok || !shot.png || leaked) {
          return {
            ok: false,
            toolCalls: shot.calls,
            errors: 1,
            retries: shot.retries,
            deepseekUsd: 0,
            evidence: `capture ${shot.kind}; ${shot.detail}; png bytes written ${png.length}; write exit ${written.exitCode}; tree leaked the code: ${leaked}; model was not asked`,
          };
        }
        const local = inspectPng(shot.png);
        const read = await readPaintedCode(input.deepseekApiKey ?? "", shot.png);
        const matched = quotedCode(read.text, code) && local.decoded && local.dark >= 20;
        return {
          ok: matched,
          toolCalls: shot.calls,
          errors: matched ? 0 : 1,
          retries: shot.retries,
          deepseekUsd: read.costUsd,
          evidence: `window png ${shot.width}x${shot.height}; sent ${local.width}x${local.height} dark ${local.dark}; bytes sent ${read.bytes}; model ${JSON.stringify(clip(read.text))}; exact ${matched}; tree leaked the code: false`,
        };
      }, boatUsd);
      flush();
    }

    const reason = await overCap();
    if (!reason) await runLanguageTasks(report, harness, languageSession.id, manager, userId, boatUsd, watched.counts, overCap);
    else report.notes.push(`Natural-language tasks were not started. ${reason}`);

    if (!(await overCap())) {
      await trial(report.kept, 2, async () => {
        await manager.stop(userId);
        const text = (await manager.read(userId, "proof/hello.txt")).text;
        const describedAfter = await manager.describe(userId);
        const ok = text === "PHASE10-FILE";
        return { ok, toolCalls: ["stop", "read"], errors: ok ? 0 : 1, retries: 0, deepseekUsd: 0, evidence: `after resume ${JSON.stringify(text)}; snapshot ${describedAfter.snapshotStatus ?? "none"}` };
      }, boatUsd);
    }
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
    const summedBoat = [...report.kept, ...report.chrome, ...report.typing, ...report.vision, ...report.naturalLanguage].reduce((sum, item) => sum + item.boatUsd, 0);
    report.totals = {
      durationMs: Date.now() - started,
      deepseekUsd: totalDeepseek(report),
      boatUsd: Math.max(spentBoat, summedBoat),
    };
    flush();
  }
  return report;
}

export function renderComputerUseMarkdown(report: ComputerUseReport): string {
  const rate = (trials: ComputerUseTrial[]) => {
    const ran = trials.filter((trial) => !trial.evidence.startsWith("skipped"));
    const ok = ran.filter((trial) => trial.ok).length;
    return ran.length ? `${ok}/${ran.length}` : "not run";
  };
  const lines = [
    "# Computer use reliability",
    "",
    "Mode: live. Performance claim: none. This is not a ranking and it does not replace the Phase 10 report.",
    "",
    report.liveExecuted ? report.liveReason : `Live run did not start. ${report.liveReason}`,
    "",
    `Started from commit 2f8675b. Protocol: ${report.protocol}. Driver errors: ${report.driverErrorCheck}.`,
    `Limits set before the run: ${report.limits.machineType}, ttl ${report.limits.ttlSeconds}s, max ${report.limits.maxSeconds}s, boat $${report.limits.boatUsd}, deepseek $${report.limits.deepseekUsd}.`,
    `Sandbox: ${report.sandboxId ?? "none"}. Deleted: ${report.deleted ? "yes" : "no"}.`,
    `Chrome ${rate(report.chrome)}. Desktop typing ${rate(report.typing)}. Visual reading ${rate(report.vision)}.`,
    `Totals: ${report.totals.durationMs} ms, deepseek $${report.totals.deepseekUsd.toFixed(6)}, boat $${report.totals.boatUsd.toFixed(6)}. Boat usage can lag the clock.`,
    "",
    ...section("Kept file, terminal, and persistence", report.kept),
    ...section("Chrome", report.chrome),
    ...section("Desktop typing", report.typing),
    ...section("Visual reading", report.vision),
    ...section("Natural language", report.naturalLanguage),
    "",
    `Schemas recorded: ${report.schemas.length}.`,
    ...report.notes.map((note) => `- ${note}`),
    "",
  ];
  return lines.join("\n");
}

async function runLanguageTasks(
  report: ComputerUseReport,
  harness: Harness,
  sessionId: string,
  manager: BoatSandboxManager,
  userId: string,
  boatUsd: () => Promise<number>,
  counts: { create: number },
  overCap: () => Promise<string>,
): Promise<void> {
  const taskIds: string[] = [];
  const spent = () => [...new Set(taskIds)].reduce((sum, id) => sum + harness.db.usageSummary(id).costUsd, 0);
  try {
    harness.start();
    const ask = async (n: number, prompt: string, check: (task: Task) => Promise<{ ok: boolean; evidence: string }>) => {
      const reason = await overCap();
      if (reason) {
        report.naturalLanguage.push(skipped(n, reason));
        return;
      }
      await trial(report.naturalLanguage, n, async () => {
        const before = spent();
        const task = await instruct(harness, sessionId, prompt);
        taskIds.push(task.id);
        const stats = toolNames(harness, task.id);
        const checked = await check(task);
        return { ...checked, toolCalls: stats, errors: stats.filter((name) => name.endsWith("!")).length, retries: task.attempt, deepseekUsd: spent() - before };
      }, boatUsd);
    };
    await ask(1, "Chrome'u aç ve https://example.com adresine git. Sayfa başlığını erişilebilirlik ağacından oku. Başlık görünmeden görevi tamamlandı sayma.", async (task) => {
      const state = await manager.desktop(userId, "nl-chrome", "get_browser_state", {}).catch((error) => ({ text: errorText(error), tree: "" }));
      const verified = /Example Domain/i.test(`${state.text}\n${state.tree}`);
      return { ok: verified, evidence: `status ${task.status}; independent title verified ${verified}; quote ${clip(task.resultText ?? "")}` };
    });
    await ask(2, "Bir metin düzenleyici aç. Belgeye tıkla, PHASE10-TYPE yaz ve proof/typed.txt olarak kaydet. Dosyayı shell ile yazma. desktop_click ve desktop_type araçlarını kullan.", async (task) => {
      const read = await proveFile(manager, userId, "proof/typed.txt");
      const names = toolNames(harness, task.id);
      const clicked = names.includes("desktop_click");
      const typed = names.includes("desktop_type");
      const shell = names.includes("shell_exec") || names.includes("code_run");
      return { ok: read.trim() === TYPE_TEXT && clicked && typed && !shell, evidence: `click ${clicked}; type ${typed}; shell ${shell}; independent read ${JSON.stringify(clip(read))}; status ${task.status}` };
    });
    const code = ALPHABET[randomInt(ALPHABET.length)]! + ALPHABET[randomInt(ALPHABET.length)]! + ALPHABET[randomInt(ALPHABET.length)]! + ALPHABET[randomInt(ALPHABET.length)]!;
    const png = labelPng(code, 48);
    await manager.run(userId, `printf %s ${quoteShell(png.toString("base64"))} | base64 -d > /home/user/linco/proof/nl-shot.png`, 20_000);
    await manager.run(userId, "DISPLAY=${DISPLAY:-:0} nohup eog /home/user/linco/proof/nl-shot.png >/tmp/nl-eog.log 2>&1 & exit 0", 15_000);
    await sleep(1500);
    await ask(3, "Masaüstündeki resim penceresinin ekran görüntüsüne bak. Boyanmış dört karakteri yalnız o görüntüden okuyup cevapla. Dosyayı açma.", async (task) => {
      const quote = task.resultText ?? "";
      const matched = quotedCode(quote, code);
      const sawImage = toolNames(harness, task.id).includes("desktop_screenshot");
      return { ok: matched && sawImage, evidence: `exact ${matched}; screenshot tool ${sawImage}; quote ${JSON.stringify(clip(quote))}; code was not in the prompt` };
    });
    await ask(4, "İki çocuk görev başlat. Birinci çocuk proof/alpha.txt dosyasına yalnız ALPHA-10 yazsın. İkinci çocuk proof/beta.txt dosyasına yalnız BETA-10 yazsın. İkisi de masaüstünü kullanmasın.", async (task) => {
      const children = harness.db.listChildren(task.id);
      const alpha = await proveFile(manager, userId, "proof/alpha.txt");
      const beta = await proveFile(manager, userId, "proof/beta.txt");
      const ok = children.length === 2 && alpha.trim() === "ALPHA-10" && beta.trim() === "BETA-10" && counts.create === 1;
      return { ok, evidence: `children ${children.length}; alpha ${JSON.stringify(clip(alpha))}; beta ${JSON.stringify(clip(beta))}; creates ${counts.create}` };
    });
  } finally {
    await harness.stop().catch(() => undefined);
  }
}

async function trial(
  bucket: ComputerUseTrial[],
  n: number,
  fn: () => Promise<{ ok: boolean; toolCalls: string[]; errors: number; retries: number; deepseekUsd: number; evidence: string }>,
  boatUsd: () => Promise<number>,
): Promise<void> {
  const started = Date.now();
  const before = await boatUsd().catch(() => 0);
  try {
    const result = await fn();
    const after = await boatUsd().catch(() => before);
    bucket.push({ n, ok: result.ok, durationMs: Date.now() - started, toolCalls: result.toolCalls, errors: result.errors, retries: result.retries, deepseekUsd: result.deepseekUsd, boatUsd: Math.max(0, after - before), evidence: clip(redact(result.evidence)) });
  } catch (error) {
    bucket.push({ n, ok: false, durationMs: Date.now() - started, toolCalls: [], errors: 1, retries: 0, deepseekUsd: 0, boatUsd: 0, evidence: clip(redact(errorText(error))) });
  }
}

function skipped(n: number, reason: string): ComputerUseTrial {
  return { n, ok: false, durationMs: 0, toolCalls: [], errors: 0, retries: 0, deepseekUsd: 0, boatUsd: 0, evidence: `skipped: ${reason}` };
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
  const deadline = Date.now() + 240_000;
  const handled = new Set<string>();
  while (Date.now() < deadline) {
    const current = harness.db.getTask(task.id);
    if (!current) break;
    if (current.status === "waiting_approval") {
      for (const approval of harness.db.listApprovals(task.id)) {
        if (approval.status !== "pending" || handled.has(approval.id)) continue;
        handled.add(approval.id);
        harness.approve(task.id, approval.id, approval.toolName.startsWith("desktop_") ? "approved" : "denied");
      }
    }
    if (current.status !== "queued" && current.status !== "running" && current.status !== "waiting_children" && current.status !== "waiting_approval") return current;
    await sleep(400);
  }
  return harness.db.getTask(task.id) ?? task;
}

function toolNames(harness: Harness, taskId: string): string[] {
  const ids = [taskId, ...harness.db.listChildren(taskId).map((child) => child.id)];
  const names: string[] = [];
  for (const id of ids) {
    for (const trace of harness.db.listTraces(id)) {
      if (trace.kind !== "tool") continue;
      const data = trace.data as { phase?: string; isError?: boolean };
      if (data.phase !== "end") continue;
      names.push(data.isError ? `${trace.name}!` : trace.name);
    }
  }
  return names;
}

function totalDeepseek(report: ComputerUseReport): number {
  return [...report.kept, ...report.chrome, ...report.typing, ...report.vision, ...report.naturalLanguage].reduce((sum, item) => sum + item.deepseekUsd, 0);
}

function section(title: string, trials: ComputerUseTrial[]): string[] {
  return [
    `## ${title}`,
    "",
    "| n | ok | ms | tools | errors | retries | deepseek usd | boat usd | evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...trials.map((item) => `| ${item.n} | ${item.ok ? "yes" : "no"} | ${item.durationMs} | ${item.toolCalls.join(", ") || "none"} | ${item.errors} | ${item.retries} | ${item.deepseekUsd.toFixed(6)} | ${item.boatUsd.toFixed(6)} | ${item.evidence.replaceAll("|", "/")} |`),
    "",
  ];
}

function writeReport(report: ComputerUseReport, directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "computer-use.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, "computer-use.md"), renderComputerUseMarkdown(report));
}

function emptyReport(): ComputerUseReport {
  return {
    createdAt: new Date().toISOString(),
    startedFrom: "2f8675b",
    mode: "live",
    performanceClaim: "none",
    liveExecuted: false,
    liveReason: "",
    limits: LIVE_LIMITS,
    sandboxId: null,
    deleted: false,
    protocol: "json-lines",
    driverErrorCheck: "isError and error content fail the tool call",
    schemas: [],
    kept: [],
    chrome: [],
    typing: [],
    vision: [],
    naturalLanguage: [],
    totals: { durationMs: 0, deepseekUsd: 0, boatUsd: 0 },
    notes: [
      "A failed desktop tool is returned to the model as a failed tool call.",
      "Shell output is not accepted as the typed file.",
      "A visual guess is accepted only when the reply is the painted code and the image was a PNG of the viewer window.",
    ],
  };
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

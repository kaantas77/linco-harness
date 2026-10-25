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
import { labelPng } from "./label-png.js";
import { BoatSandboxManager } from "./manager.js";
import { ASSUMED_DESKTOP_TOOLS } from "./mcp.js";
import { quoteShell } from "./paths.js";
import { redactBoat } from "./redact.js";

/** Caps chosen before any live call. Small machine, twenty minute lifetime, then delete. */
export const LIVE_LIMITS = {
  machineType: "small" as const,
  ttlSeconds: 1500,
  maxSeconds: 1200,
  boatUsd: 0.1,
  deepseekUsd: 0.75,
  scenarioMs: 150_000,
  readyTimeoutMs: 180_000,
};

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface BoatLiveScenario {
  id: string;
  ok: boolean;
  skipped: boolean;
  durationMs: number;
  deepseekUsd: number;
  boatUsd: number;
  toolCalls: number;
  errors: number;
  retries: number;
  detail: string;
}

export interface BoatLiveReport {
  createdAt: string;
  mode: "live";
  performanceClaim: "none";
  liveExecuted: boolean;
  liveReason: string;
  limits: typeof LIVE_LIMITS;
  sandboxId: string | null;
  deleted: boolean;
  mcpTools: string[];
  assumedTools: string[];
  missingTools: string[];
  extraTools: string[];
  states: string[];
  scenarios: BoatLiveScenario[];
  notes: string[];
}

export async function runBoatLive(input: {
  boatApiKey?: string;
  deepseekApiKey?: string;
  boatBaseUrl?: string;
}): Promise<BoatLiveReport> {
  const report = emptyReport();
  if (!input.boatApiKey || !input.deepseekApiKey) {
    report.liveReason = !input.boatApiKey ? "BOAT_API_KEY is unset" : "DEEPSEEK_API_KEY is unset";
    return report;
  }
  report.liveExecuted = true;
  report.liveReason = "Railway variables were injected for this process. Values were not written to the report.";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-boat-live-"));
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
  const deepseek = createDeepSeek("deepseek-flash");
  const vision = { parts: 0, bytes: 0 };
  const streamFn: StreamFn = (model, context, options) => {
    const found = countImages(context);
    vision.parts += found.parts;
    vision.bytes += found.bytes;
    return deepseek.streamFn(model, context, options);
  };
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
    streamFn,
    boatReadyTimeoutMs: LIVE_LIMITS.readyTimeoutMs,
  });
  const taskIds: string[] = [];
  let sandboxId = "";
  let userId = "";
  let blocked = "";
  const remember = (task: Task) => {
    taskIds.push(task.id);
    for (const child of harness.db.listChildren(task.id)) taskIds.push(child.id);
  };
  const deepseekUsd = () => [...new Set(taskIds)].reduce((sum, id) => sum + harness.db.usageSummary(id).costUsd, 0);
  const boatUsd = async () => (await manager.describe(userId)).usage?.dollars ?? 0;
  const capReason = async () => {
    if (blocked) return blocked;
    const boat = userId ? await boatUsd() : 0;
    const spent = deepseekUsd();
    if (boat >= LIVE_LIMITS.boatUsd) blocked = `boat usage ${boat} reached the ${LIVE_LIMITS.boatUsd} dollar cap`;
    else if (spent >= LIVE_LIMITS.deepseekUsd) blocked = `deepseek usage ${spent} reached the ${LIVE_LIMITS.deepseekUsd} dollar cap`;
    return blocked;
  };
  const runScenario = async (id: string, fn: () => Promise<{ ok: boolean; detail: string; toolCalls?: number; errors?: number; retries?: number }>) => {
    const started = Date.now();
    const boatBefore = userId ? await boatUsd().catch(() => 0) : 0;
    const deepBefore = deepseekUsd();
    const reason = await capReason();
    if (reason) {
      report.scenarios.push(row(id, false, true, Date.now() - started, 0, 0, 0, 0, 0, reason));
      return;
    }
    try {
      const result = await fn();
      report.scenarios.push(
        row(id, result.ok, false, Date.now() - started, deepseekUsd() - deepBefore, (userId ? await boatUsd().catch(() => boatBefore) : boatBefore) - boatBefore, result.toolCalls ?? 0, result.errors ?? 0, result.retries ?? 0, result.detail),
      );
    } catch (error) {
      report.scenarios.push(row(id, false, false, Date.now() - started, deepseekUsd() - deepBefore, 0, 0, 1, 0, clip(redact(errorText(error)))));
    }
  };

  try {
    harness.start();
    const user = harness.createUser("Live");
    userId = user.id;
    const session = harness.createSession(user.id);
    const hostSecret = path.join(user.workspacePath, "host-only.txt");
    fs.writeFileSync(hostSecret, "HOST-ONLY-PHASE10");

    await runScenario("connect", async () => {
      const ready = await manager.ensure(user.id);
      sandboxId = ready.sandboxId ?? "";
      report.sandboxId = sandboxId || null;
      const again = await manager.ensure(user.id);
      const described = await manager.describe(user.id);
      if (described.usage) report.states.push(`usage seconds=${described.usage.seconds} type=${described.usage.sandboxType}`);
      report.states.push(`ready ${ready.status}`);
      const same = again.sandboxId === sandboxId && watched.counts.create === 1;
      return { ok: Boolean(sandboxId) && same, detail: same ? `one sandbox ${sandboxId}` : `create calls ${watched.counts.create}` };
    });
    if (!sandboxId) {
      report.notes.push("No sandbox was ready, so the later scenarios were not started.");
      return report;
    }

    await runScenario("daemon", async () => {
      const status = await manager.run(
        user.id,
        "systemctl --user is-active cua-driver.service; systemctl --user status cua-driver.service --no-pager; echo '---'; ls -l /run/ascii-cua 2>&1; echo '---'; /opt/ascii/cua-driver/cua-driver status --socket /run/ascii-cua/driver.sock 2>&1 | head -n 20",
        20_000,
      );
      const lines = status.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /active|sock|cua-driver|listen|running|failed|error|inactive/i.test(line))
        .slice(0, 8);
      return { ok: /active/.test(status.stdout) && /driver\.sock/.test(status.stdout), detail: lines.join(" | ") || clip(status.stdout || status.stderr) };
    });

    await runScenario("mcp-tools", async () => {
      const listed = await manager.desktop(user.id, "probe-list", "tools/list", {});
      const names = parseNames(listed.text);
      report.mcpTools = names;
      report.missingTools = ASSUMED_DESKTOP_TOOLS.filter((name) => !names.includes(name));
      report.extraTools = names.filter((name) => !ASSUMED_DESKTOP_TOOLS.includes(name));
      return {
        ok: report.missingTools.length === 0 && names.length > 0,
        detail: names.length ? `listed ${names.length}; missing ${report.missingTools.join(", ") || "none"}` : "tools/list returned no names",
      };
    });

    await runScenario("api-error", async () => {
      try {
        await watched.client.get("sbx_phase10_missing");
        return { ok: false, detail: "missing sandbox id returned a sandbox" };
      } catch (error) {
        const message = redact(errorText(error));
        const clear = /boat api \d+/.test(message) && !/boat_[A-Za-z0-9_-]{8,}/.test(message) && !message.includes("sk-");
        return { ok: clear, detail: clip(message) };
      }
    });

    const instructed = async (
      id: string,
      prompt: string,
      check: (task: Task) => Promise<{ ok: boolean; detail: string }>,
      timeoutMs = LIVE_LIMITS.scenarioMs,
    ) => {
      await runScenario(id, async () => {
        const task = await instruct(harness, session.id, prompt, timeoutMs, capReason);
        remember(task);
        const stats = toolStats(harness, task.id);
        const checked = await check(task);
        return { ...checked, toolCalls: stats.calls, errors: stats.errors, retries: task.attempt };
      });
    };

    await instructed(
      "files",
      "proof adında bir klasör oluştur. İçine hello.txt yaz. Dosyanın tam içeriği PHASE10-FILE olsun. Başka satır ekleme.",
      async (task) => {
        const text = await readText(manager, user.id, "proof/hello.txt");
        return { ok: task.status === "succeeded" && text === "PHASE10-FILE", detail: `status ${task.status}; read ${JSON.stringify(text)}` };
      },
    );

    await runScenario("persist", async () => {
      await manager.stop(user.id);
      report.states.push("stopped");
      const text = await readText(manager, user.id, "proof/hello.txt");
      const described = await manager.describe(user.id);
      report.states.push(`resumed ${described.status} snapshot ${described.snapshotStatus ?? "none"}`);
      return { ok: text === "PHASE10-FILE", detail: `after resume read ${JSON.stringify(text)}` };
    });

    await instructed(
      "terminal",
      "proof/main.mjs dosyasına bir Node programı yaz. Program yalnız PHASE10-RUN yazdırsın. Sonra node proof/main.mjs komutunu çalıştır.",
      async (task) => {
        const ran = await manager.run(user.id, "node proof/main.mjs", 20_000);
        const printed = ran.stdout.trim() === "PHASE10-RUN";
        return { ok: task.status === "succeeded" && printed, detail: `status ${task.status}; independent stdout ${JSON.stringify(ran.stdout.trim())} exit ${ran.exitCode}` };
      },
    );

    await instructed(
      "chrome",
      "Chrome'u aç ve https://example.com adresine git. Sayfa başlığını söyle.",
      async (task) => {
        const page = await manager.desktop(user.id, "probe-browser", "get_browser_state", {});
        const title = /Example Domain/.test(page.tree) || /Example Domain/.test(page.text);
        return { ok: task.status === "succeeded" && title, detail: `status ${task.status}; tree has Example Domain: ${title}` };
      },
      240_000,
    );

    await instructed(
      "desktop-input",
      "Bir metin düzenleyici aç. Belgenin içine tıkla ve PHASE10-TYPE yaz. Dosyayı proof/typed.txt olarak kaydet. Bu metni kabukla dosyaya yazma.",
      async (task) => {
        const text = await readText(manager, user.id, "proof/typed.txt");
        const names = toolStats(harness, task.id).names;
        const usedDesktop = names.includes("desktop_click") && names.includes("desktop_type");
        return {
          ok: text.includes("PHASE10-TYPE") && usedDesktop,
          detail: `read ${JSON.stringify(text)}; tools ${names.join(", ") || "none"}`,
        };
      },
      240_000,
    );

    const code = Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    let treeHasCode = false;
    await runScenario("vision-setup", async () => {
      const png = labelPng(code);
      const written = await manager.run(
        user.id,
        `printf %s ${quoteShell(png.toString("base64"))} | base64 -d > /home/user/linco/shot.png && ls -l /home/user/linco/shot.png`,
        20_000,
      );
      const opened = await manager.run(
        user.id,
        "DISPLAY=${DISPLAY:-:0} nohup sh -c 'if command -v eog >/dev/null; then eog /home/user/linco/shot.png; elif command -v google-chrome >/dev/null; then google-chrome --new-window file:///home/user/linco/shot.png; else xdg-open /home/user/linco/shot.png; fi' >/tmp/open-shot.log 2>&1 & exit 0",
        15_000,
      );
      await sleep(2500);
      const seen = await manager.desktop(user.id, "probe-vision", "get_desktop_state", {});
      treeHasCode = seen.tree.includes(code) || seen.text.includes(code);
      const pngText = png.toString("utf8");
      const pixelsOnly = !pngText.includes(code);
      return {
        ok: written.exitCode === 0 && opened.exitCode === 0 && pixelsOnly,
        detail: `png bytes ${png.length}; tree contains the code: ${treeHasCode}; write exit ${written.exitCode}; open exit ${opened.exitCode}`,
      };
    });

    const partsBefore = vision.parts;
    await instructed(
      "vision",
      "Masaüstündeki resme bak. Bir kez desktop_screenshot çağır. Resmin içinde boyanmış dört karakterlik kodu yalnız ekran görüntüsünden okuyup cevapla. shot.png dosyasını okuma.",
      async (task) => {
        const quote = clip(task.resultText ?? "");
        const attached = vision.parts > partsBefore;
        const answered = quote.includes(code);
        const isolated = answered && attached && !treeHasCode;
        return {
          ok: isolated,
          detail: `model quoted the code: ${answered}; image parts sent: ${vision.parts - partsBefore}; image bytes: ${vision.bytes}; accessibility tree contained the code: ${treeHasCode}; quote ${JSON.stringify(quote)}`,
        };
      },
      240_000,
    );

    await instructed(
      "subagents",
      "İki çocuk görev başlat. Birinci çocuk proof/alpha.txt dosyasına yalnız ALPHA-10 yazsın. İkinci çocuk proof/beta.txt dosyasına yalnız BETA-10 yazsın. İkisi de masaüstünü kullanmasın. İkisi bitmeden bu görevi tamamlandı sayma.",
      async (task) => {
        const children = harness.db.listChildren(task.id);
        for (const child of children) taskIds.push(child.id);
        const alpha = (await readText(manager, user.id, "proof/alpha.txt")).trim();
        const beta = (await readText(manager, user.id, "proof/beta.txt")).trim();
        return {
          ok: children.length === 2 && alpha === "ALPHA-10" && beta === "BETA-10" && watched.counts.create === 1,
          detail: `children ${children.length}; alpha ${JSON.stringify(alpha)}; beta ${JSON.stringify(beta)}; creates ${watched.counts.create}`,
        };
      },
    );

    await runScenario("desktop-lock", async () => {
      const both = await Promise.allSettled([
        manager.desktop(user.id, "lock-a", "get_desktop_state", {}),
        manager.desktop(user.id, "lock-b", "get_desktop_state", {}),
      ]);
      const rejected = both.filter((item) => item.status === "rejected");
      const message = rejected.map((item) => redact(errorText(item.reason))).join(" | ");
      const blockedOther = rejected.some((item) => /in use/.test(errorText(item.reason)));
      return { ok: blockedOther, detail: `rejected ${rejected.length}; ${clip(message || "both calls finished")}` };
    });

    await runScenario("no-retry", async () => {
      const before = watched.counts.command;
      const failed = await manager.run(user.id, "false", 10_000);
      const delta = watched.counts.command - before;
      return { ok: failed.exitCode !== 0 && delta === 1, detail: `exit ${failed.exitCode}; command calls ${delta}` };
    });

    await runScenario("timeout", async () => {
      const started = Date.now();
      const result = await manager.run(user.id, "sleep 30", 1_000);
      const elapsed = Date.now() - started;
      return { ok: result.timedOut && elapsed < 8_000, detail: `timedOut ${result.timedOut}; elapsed ${elapsed}` };
    });

    await runScenario("abort", async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 300);
      try {
        await manager.run(user.id, "sleep 20", 15_000, controller.signal);
        return { ok: false, detail: "aborted command resolved" };
      } catch (error) {
        const message = redact(errorText(error));
        return { ok: message === "aborted", detail: clip(message) };
      } finally {
        clearTimeout(timer);
      }
    });

    await runScenario("other-user", async () => {
      const other = harness.createUser("Other");
      const described = await manager.describe(other.id);
      const hostStill = fs.readFileSync(hostSecret, "utf8") === "HOST-ONLY-PHASE10";
      const remote = await manager.run(user.id, `cat ${quoteShell(hostSecret)}`, 15_000);
      return {
        ok: described.status === "absent" && described.sandboxId === null && watched.counts.create === 1 && hostStill && remote.exitCode !== 0,
        detail: `other status ${described.status}; creates ${watched.counts.create}; host unchanged ${hostStill}; vm cat exit ${remote.exitCode}`,
      };
    });
  } finally {
    if (userId && sandboxId) {
      try {
        await manager.stop(userId);
        report.states.push("final-stop");
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
  }
  return report;
}

export function renderBoatLiveMarkdown(report: BoatLiveReport): string {
  const lines = [
    "# Linco on a real Boat computer",
    "",
    `Mode: live. Performance claim: none. This is not a ranking.`,
    "",
    report.liveExecuted ? report.liveReason : `Live run did not start. ${report.liveReason}`,
    "",
    `Limits set before the run: ${report.limits.machineType}, ttl ${report.limits.ttlSeconds}s, max ${report.limits.maxSeconds}s, boat $${report.limits.boatUsd}, deepseek $${report.limits.deepseekUsd}.`,
    `Sandbox: ${report.sandboxId ?? "none"}. Deleted: ${report.deleted ? "yes" : "no"}.`,
    `MCP tools: ${report.mcpTools.join(", ") || "none"}. Missing assumed tools: ${report.missingTools.join(", ") || "none"}.`,
    `States: ${report.states.join("; ") || "none"}.`,
    "",
    "| scenario | ok | skipped | ms | deepseek usd | boat usd | tools | errors | retries | detail |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.scenarios.map(
      (item) =>
        `| ${item.id} | ${item.ok ? "yes" : "no"} | ${item.skipped ? "yes" : "no"} | ${item.durationMs} | ${item.deepseekUsd.toFixed(6)} | ${item.boatUsd.toFixed(6)} | ${item.toolCalls} | ${item.errors} | ${item.retries} | ${item.detail.replaceAll("|", "/")} |`,
    ),
    "",
    ...report.notes.map((note) => `- ${note}`),
    "",
  ];
  return lines.join("\n");
}

function emptyReport(): BoatLiveReport {
  return {
    createdAt: new Date().toISOString(),
    mode: "live",
    performanceClaim: "none",
    liveExecuted: false,
    liveReason: "",
    limits: LIVE_LIMITS,
    sandboxId: null,
    deleted: false,
    mcpTools: [],
    assumedTools: [...ASSUMED_DESKTOP_TOOLS],
    missingTools: [],
    extraTools: [],
    states: [],
    scenarios: [],
    notes: [],
  };
}

function row(
  id: string,
  ok: boolean,
  skipped: boolean,
  durationMs: number,
  deepseekUsd: number,
  boatUsd: number,
  toolCalls: number,
  errors: number,
  retries: number,
  detail: string,
): BoatLiveScenario {
  return { id, ok, skipped, durationMs, deepseekUsd, boatUsd, toolCalls, errors, retries, detail: clip(redact(detail)) };
}

async function instruct(
  harness: Harness,
  sessionId: string,
  prompt: string,
  timeoutMs: number,
  capReason: () => Promise<string>,
): Promise<Task> {
  const task = await harness.submit(sessionId, prompt, { waitMs: 0, maxAttempts: 1 });
  const deadline = Date.now() + timeoutMs;
  const handled = new Set<string>();
  while (Date.now() < deadline) {
    if (await capReason()) {
      harness.cancel(task.id);
      break;
    }
    const current = harness.db.getTask(task.id);
    if (!current) break;
    if (current.status === "waiting_approval") {
      for (const approval of harness.db.listApprovals(task.id)) {
        if (approval.status !== "pending" || handled.has(approval.id)) continue;
        handled.add(approval.id);
        const desktop = approval.toolName.startsWith("desktop_");
        harness.approve(task.id, approval.id, desktop ? "approved" : "denied");
      }
    }
    if (current.status !== "queued" && current.status !== "running" && current.status !== "waiting_children" && current.status !== "waiting_approval") {
      return current;
    }
    await sleep(400);
  }
  return harness.db.getTask(task.id) ?? task;
}

function toolStats(harness: Harness, taskId: string): { calls: number; errors: number; names: string[] } {
  const ids = [taskId, ...harness.db.listChildren(taskId).map((child) => child.id)];
  const names: string[] = [];
  let errors = 0;
  for (const id of ids) {
    for (const trace of harness.db.listTraces(id)) {
      if (trace.kind !== "tool") continue;
      const data = trace.data as { phase?: string; isError?: boolean };
      if (data.phase !== "end") continue;
      names.push(trace.name);
      if (data.isError) errors += 1;
    }
  }
  return { calls: names.length, errors, names };
}

async function readText(manager: BoatSandboxManager, userId: string, relativePath: string): Promise<string> {
  try {
    return (await manager.read(userId, relativePath)).text;
  } catch (error) {
    return `READ FAILED ${errorText(error)}`;
  }
}

function parseNames(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function countImages(context: unknown): { parts: number; bytes: number } {
  let parts = 0;
  let bytes = 0;
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as { type?: string; data?: string; content?: unknown; messages?: unknown };
    if (record.type === "image" && typeof record.data === "string") {
      parts += 1;
      bytes += record.data.length;
    }
    if (record.content) visit(record.content);
    if (record.messages) visit(record.messages);
  };
  visit((context as { messages?: unknown }).messages);
  return { parts, bytes };
}

function watchClient(inner: BoatClient): { client: BoatClient; counts: { create: number; command: number } } {
  const counts = { create: 0, command: 0 };
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
      command: async (input) => {
        counts.command += 1;
        return inner.command(input);
      },
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
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 360 ? `${flat.slice(0, 360)}…` : flat;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

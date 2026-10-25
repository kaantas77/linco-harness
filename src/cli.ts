#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Harness } from "./agent/runtime.js";
import { runComparison } from "./bench/compare.js";
import { renderContextMarkdown, runContextOffline } from "./bench/context.js";
import { renderContextLiveMarkdown, runContextLive } from "./bench/context-live.js";
import { renderDurableMarkdown, runDurableBench } from "./bench/durable.js";
import { offlineRowsToReport, renderBenchMarkdown, writeBenchReport } from "./bench/report.js";
import { runOfflineBench } from "./bench/runner.js";
import { redactSecrets } from "./bench/types.js";
import { loadConfig } from "./config.js";
import { HarnessServer } from "./server/http.js";

const [command, ...args] = process.argv.slice(2);

if (!command || command === "help" || command === "--help") {
  console.log(`linco serve [--port 8787] [--data .data]
linco task --user <name> "<prompt>"
linco bench [--out reports]
linco bench --live [--out reports] [--data .data-bench]
linco bench --context [--out reports] [--data .data-bench]
linco bench --durable [--out reports]
linco worker [--data .data] [--workers 1]
Auth defaults to token. LINCO_AUTH=dev keeps the open loopback API.
LINCO_BOOTSTRAP_TOKEN creates users. LINCO_ALLOW_LOOPBACK=1 opens local URLs.
LINCO_SANDBOX=off runs shell and code mode without an OS sandbox.`);
  process.exit(0);
}

if (command === "serve") {
  const config = loadConfig({ port: flagNumber(args, "--port"), dataDir: flagValue(args, "--data") });
  const harness = new Harness({ config });
  const server = new HarnessServer(harness);
  harness.start();
  const port = await server.listen();
  console.log(`linco listening on http://${config.host}:${port} with ${config.workerCount} workers (${config.authMode})`);
  if (config.authMode === "token" && !config.bootstrapToken && harness.bootstrapToken) {
    console.error("linco bootstrap token (shown once; it is not saved in the clear):");
    console.error(harness.bootstrapToken);
  }
  const shutdown = async () => {
    await server.close();
    await harness.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
} else if (command === "task") {
  const config = loadConfig({ dataDir: flagValue(args, "--data") });
  const userName = flagValue(args, "--user") ?? "local";
  const prompt = positionals(args).join(" ").trim();
  if (!prompt) throw new Error("prompt is required");
  const harness = new Harness({ config });
  harness.start();
  try {
    const user = harness.db.findUserByName(userName) ?? harness.createUser(userName);
    const session = harness.db.latestSession(user.id) ?? harness.createSession(user.id);
    const task = await harness.submit(session.id, prompt, { waitMs: 120_000 });
    const usage = harness.db.usageSummary(task.id);
    console.log(JSON.stringify({ task, usage }, null, 2));
    process.exitCode = task.status === "succeeded" ? 0 : 1;
  } finally {
    await harness.stop();
  }
} else if (command === "bench") {
  const config = loadConfig({ dataDir: flagValue(args, "--data") ?? path.resolve(".data-bench") });
  const out = flagValue(args, "--out") ?? path.resolve("reports");
  if (args.includes("--durable")) {
    const report = await runDurableBench(config.skillsDir);
    const written = writeReport(out, "durable", report, renderDurableMarkdown(report));
    console.log(renderDurableMarkdown(report));
    console.log(`wrote ${written.json}`);
    console.log(`wrote ${written.markdown}`);
    process.exitCode = report.cases.every((row) => row.doubleRuns === 0 && row.lostTranscripts === 0) ? 0 : 1;
  } else if (args.includes("--context")) {
    const offline = await runContextOffline(config.skillsDir);
    const offlinePath = writeReport(out, "context", offline, renderContextMarkdown(offline));
    console.log(renderContextMarkdown(offline));
    console.log(`wrote ${offlinePath.json}`);
    console.log(`wrote ${offlinePath.markdown}`);
    if (config.apiKey) {
      const live = await runContextLive(config);
      const livePath = writeReport(out, "context-live", live, renderContextLiveMarkdown(live));
      console.log(renderContextLiveMarkdown(live));
      console.log(`wrote ${livePath.json}`);
      console.log(`wrote ${livePath.markdown}`);
      process.exitCode = live.liveExecuted && live.summary.some((row) => row.successRate === 0) ? 1 : 0;
    } else {
      console.log("live context benchmark skipped: DEEPSEEK_API_KEY is unset");
    }
  } else if (args.includes("--live")) {
    const report = await runComparison(config);
    const written = writeBenchReport(out, "live", report);
    console.log(renderBenchMarkdown(report));
    console.log(`wrote ${written.json}`);
    console.log(`wrote ${written.markdown}`);
    process.exitCode = report.liveExecuted && report.results.some((row) => !row.ok) ? 1 : 0;
  } else {
    const rows = await runOfflineBench({ dataDir: config.dataDir, skillsDir: config.skillsDir });
    const report = offlineRowsToReport(rows);
    const written = writeBenchReport(out, "offline", report);
    console.table(rows.map(({ id, group, ok, status, durationMs, detail }) => ({ id, group, ok, status, durationMs, detail })));
    console.log(`wrote ${written.json}`);
    console.log(`wrote ${written.markdown}`);
    process.exitCode = rows.every((row) => row.ok) ? 0 : 1;
  }
} else if (command === "worker") {
  const config = loadConfig({
    dataDir: flagValue(args, "--data"),
    workerCount: flagNumber(args, "--workers") ?? 1,
    manageCredentials: false,
  });
  const harness = new Harness({ config });
  harness.start();
  console.log(`linco worker ${process.pid} reading ${config.dataDir} with ${config.workerCount} loops`);
  const stay = setInterval(() => undefined, 60_000);
  const shutdown = async () => {
    clearInterval(stay);
    await harness.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
} else {
  throw new Error(`unknown command ${command}`);
}

function writeReport(directory: string, name: string, report: unknown, markdown: string): { json: string; markdown: string } {
  fs.mkdirSync(directory, { recursive: true });
  const json = path.join(directory, `${name}.json`);
  const markdownPath = path.join(directory, `${name}.md`);
  const safe = JSON.parse(redactSecrets(JSON.stringify(report))) as unknown;
  fs.writeFileSync(json, `${JSON.stringify(safe, null, 2)}\n`);
  fs.writeFileSync(markdownPath, redactSecrets(markdown));
  return { json, markdown: markdownPath };
}

function positionals(argv: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--user" || arg === "--data" || arg === "--port" || arg === "--out" || arg === "--workers") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    values.push(arg);
  }
  return values;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function flagNumber(argv: string[], flag: string): number | undefined {
  const value = flagValue(argv, flag);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

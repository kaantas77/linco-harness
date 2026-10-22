#!/usr/bin/env node
import path from "node:path";
import { Harness } from "./agent/runtime.js";
import { runComparison } from "./bench/compare.js";
import { offlineRowsToReport, renderBenchMarkdown, writeBenchReport } from "./bench/report.js";
import { runOfflineBench } from "./bench/runner.js";
import { loadConfig } from "./config.js";
import { HarnessServer } from "./server/http.js";

const [command, ...args] = process.argv.slice(2);

if (!command || command === "help" || command === "--help") {
  console.log(`linco serve [--port 8787] [--data .data]
linco task --user <name> "<prompt>"
linco bench [--out reports]
linco bench --live [--out reports] [--data .data-bench]`);
  process.exit(0);
}

if (command === "serve") {
  const config = loadConfig({ port: flagNumber(args, "--port"), dataDir: flagValue(args, "--data") });
  const harness = new Harness({ config });
  const server = new HarnessServer(harness);
  harness.start();
  const port = await server.listen();
  console.log(`linco listening on http://${config.host}:${port} with ${config.workerCount} workers`);
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
  if (args.includes("--live")) {
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
} else {
  throw new Error(`unknown command ${command}`);
}

function positionals(argv: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--user" || arg === "--data" || arg === "--port" || arg === "--out") {
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

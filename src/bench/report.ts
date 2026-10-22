import fs from "node:fs";
import path from "node:path";
import { cacheHitRatio, cacheMissTokens } from "./metrics.js";
import type { BenchReport, ScenarioResult } from "./types.js";
import { redactSecrets } from "./types.js";

export function offlineRowsToReport(
  rows: { id: string; group: string; ok: boolean; status: string; durationMs: number; detail: string }[],
): BenchReport {
  const empty = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, userTurn: 0 };
  return {
    createdAt: new Date().toISOString(),
    mode: "offline",
    model: "scripted",
    liveExecuted: false,
    performanceClaim: "none",
    results: rows.map((row) => ({
      runner: "linco" as const,
      scenarioId: row.id,
      group: row.group,
      ok: row.ok,
      status: row.status,
      durationMs: row.durationMs,
      firstResponseMs: null,
      usage: { ...empty, userTurn: 0 },
      cacheHitRatio: 0,
      calls: [],
      cache: emptyCache(),
      detail: row.detail,
    })),
    notes: [
      "Offline rows use the scripted model. They do not measure DeepSeek latency, tokens, or cost.",
      "Live verification is `linco bench --live`. Until that report says live executed, do not compare runners.",
    ],
  };
}

export function pendingLiveReport(model: string): BenchReport {
  return {
    createdAt: new Date().toISOString(),
    mode: "live",
    model,
    liveExecuted: false,
    performanceClaim: "none",
    results: [],
    notes: [
      "DEEPSEEK_API_KEY is not set. Live verification was not run.",
      "No latency, token, cache, or cost comparison was produced.",
      "Do not describe either runner as faster, cheaper, or more accurate from this report.",
    ],
  };
}

export function renderBenchMarkdown(report: BenchReport): string {
  const lines = [
    "# Linco benchmark",
    "",
    `Created: ${report.createdAt}`,
    `Mode: ${report.mode}`,
    `Model: ${report.model}`,
    `Live executed: ${report.liveExecuted ? "yes" : "no"}`,
    "Performance claim: none. These rows are measurements from this run, not a ranking.",
    "",
  ];
  if (!report.liveExecuted) {
    lines.push("Live verification is pending. This file does not contain API latency or cost.", "");
  }
  if (report.results.length === 0) {
    lines.push("No scenario rows.", "");
  } else {
    lines.push(
      "| Runner | Scenario | OK | Status | Duration ms | First response ms | Input | Output | Cache hit | Cache miss | Cost USD |",
      "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const row of report.results) {
      lines.push(
        `| ${row.runner} | ${row.scenarioId} | ${row.ok ? "yes" : "no"} | ${row.status} | ${row.durationMs} | ${row.firstResponseMs ?? ""} | ${row.usage.inputTokens} | ${row.usage.outputTokens} | ${row.usage.cacheReadTokens} | ${cacheMissTokens(row.usage)} | ${row.usage.costUsd.toFixed(6)} |`,
      );
    }
    lines.push("", "## Cache checks", "");
    for (const row of report.results) {
      lines.push(
        `- ${row.runner} / ${row.scenarioId}: first model call cacheRead ${formatNullable(row.cache.firstCallCacheRead)}, second model call cacheRead ${formatNullable(row.cache.secondCallCacheRead)} (hit ${formatNullable(row.cache.secondCallHit)}), second user turn cacheRead ${formatNullable(row.cache.secondUserTurnCacheRead)} (hit ${formatNullable(row.cache.secondUserTurnHit)}), system prompt stable ${formatNullable(row.cache.systemPromptStable)}, tool order stable ${formatNullable(row.cache.toolOrderStable)}, reasoning preserved ${formatNullable(row.cache.reasoningPreserved)}. ${redactSecrets(row.detail)}`,
      );
    }
    lines.push("");
  }
  if (report.notes.length > 0) {
    lines.push("## Notes", "");
    for (const note of report.notes) lines.push(`- ${redactSecrets(note)}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function writeBenchReport(directory: string, name: string, report: BenchReport): { json: string; markdown: string } {
  fs.mkdirSync(directory, { recursive: true });
  const json = path.join(directory, `${name}.json`);
  const markdown = path.join(directory, `${name}.md`);
  const safe = JSON.parse(redactSecrets(JSON.stringify(report))) as BenchReport;
  fs.writeFileSync(json, `${JSON.stringify(safe, null, 2)}\n`);
  fs.writeFileSync(markdown, renderBenchMarkdown(safe));
  return { json, markdown };
}

export function emptyCache(): ScenarioResult["cache"] {
  return {
    firstCallCacheRead: null,
    secondCallCacheRead: null,
    secondCallHit: null,
    secondUserTurnCacheRead: null,
    secondUserTurnHit: null,
    systemPromptStable: null,
    toolOrderStable: null,
    reasoningPreserved: null,
  };
}

export function usageRatio(usage: ScenarioResult["usage"]): number {
  return cacheHitRatio(usage);
}

function formatNullable(value: number | boolean | null): string {
  if (value === null) return "n/a";
  return String(value);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Harness } from "../agent/runtime.js";
import { loadConfig } from "../config.js";
import { SCRIPT_MODEL, scriptedReply } from "../llm/scripted.js";

export interface ContextScenario {
  id: string;
  mode: "on" | "off";
  ok: boolean;
  status: string;
  durationMs: number;
  compacted: boolean;
  beforeChars: number;
  afterChars: number;
  beforeTokens: number;
  afterTokens: number;
  recordKeepsCritical: boolean;
  detail: string;
}

export interface ContextReport {
  createdAt: string;
  mode: "offline";
  model: "scripted";
  liveExecuted: false;
  performanceClaim: "none";
  defaultCompactMaxChars: number;
  scenarios: ContextScenario[];
  notes: string[];
}

const DEFAULT_COMPACT_CHARS = 180_000;

/** Fat middle turns with a short first instruction and a short recent tail. */
export function buildLongTranscript(system: string, targetChars: number): AgentMessage[] {
  const messages: AgentMessage[] = [
    { role: "system", content: system, timestamp: 0 },
    { role: "user", content: "First instruction: leave existing files alone.", timestamp: 1 },
  ];
  let index = 0;
  while (JSON.stringify(messages).length < targetChars && index < 40) {
    messages.push({
      role: "user",
      content: `MIDDLE-ONLY filler ${index} ${"m".repeat(8_000)}`,
      timestamp: index + 2,
    });
    index += 1;
  }
  for (let tail = 0; tail < 8; tail += 1) {
    messages.push({ role: "user", content: `recent ${tail}`, timestamp: 100 + tail });
  }
  return messages;
}

export async function runContextOffline(skillsDir: string): Promise<ContextReport> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-context-"));
  try {
    const scenarios = [
      await runCase(path.join(root, "short-on"), skillsDir, "short-on", true, false),
      await runCase(path.join(root, "short-off"), skillsDir, "short-off", false, false),
      await runCase(path.join(root, "long-on"), skillsDir, "long-on", true, true),
      await runCase(path.join(root, "long-off"), skillsDir, "long-off", false, true),
    ];
    return {
      createdAt: new Date().toISOString(),
      mode: "offline",
      model: "scripted",
      liveExecuted: false,
      performanceClaim: "none",
      defaultCompactMaxChars: DEFAULT_COMPACT_CHARS,
      scenarios,
      notes: [
        "Scripted rows prove task success and that the SQLite transcript stays intact. They are not DeepSeek token, cache, or dollar figures.",
        "Token estimates are serialized characters divided by 4.",
        "The default request budget stays 180000 characters. The long scripted row uses a smaller budget so compaction is observable without a large fixture.",
        "A short transcript does not compact. Compaction is pair-safe only when the budget is already exceeded.",
        "LINCO_COMPACT=0 leaves the stored transcript unchanged on the model request.",
      ],
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function renderContextMarkdown(report: ContextReport): string {
  const lines = [
    "# Linco context benchmark",
    "",
    `Mode: ${report.mode}. Model: ${report.model}. Live executed: ${report.liveExecuted}. Performance claim: ${report.performanceClaim}.`,
    "",
    "| scenario | mode | ok | status | ms | compacted | before chars | after chars | record kept | detail |",
    "| --- | --- | --- | --- | ---: | --- | ---: | ---: | --- | --- |",
  ];
  for (const row of report.scenarios) {
    lines.push(
      `| ${row.id} | ${row.mode} | ${row.ok ? "yes" : "no"} | ${row.status} | ${row.durationMs} | ${row.compacted ? "yes" : "no"} | ${row.beforeChars} | ${row.afterChars} | ${row.recordKeepsCritical ? "yes" : "no"} | ${row.detail} |`,
    );
  }
  lines.push("", "## Notes", "");
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push("");
  return lines.join("\n");
}

async function runCase(
  dataDir: string,
  skillsDir: string,
  id: string,
  compactRequests: boolean,
  long: boolean,
): Promise<ContextScenario> {
  const harness = new Harness({
    config: loadConfig({
      dataDir,
      skillsDir,
      workerCount: 1,
      schedulerIntervalMs: 60_000,
      port: 0,
      compactRequests,
      compactMaxChars: long ? 4_000 : DEFAULT_COMPACT_CHARS,
    }),
    model: SCRIPT_MODEL,
    streamFn: scriptedReply((messages) => {
      const rows = messages as Array<{ role: string }>;
      if (rows.some((message) => message.role === "toolResult")) return { text: "wrote pear" };
      return { calls: [{ name: "fs_write", arguments: { path: "note.txt", content: "pear" } }] };
    }),
  });
  harness.start();
  const started = Date.now();
  try {
    const user = harness.createUser(id);
    const session = harness.createSession(user.id);
    if (long) harness.db.setTranscript(session.id, buildLongTranscript(session.systemPrompt, 12_000), "seed");
    const task = await harness.submit(session.id, "Use fs_write to create note.txt containing exactly pear. Then stop.", {
      kind: "bench",
      waitMs: 10_000,
      maxAttempts: 1,
    });
    const transcript = JSON.stringify(harness.db.getTranscript(session.id));
    const compact = harness.db.listTraces(task.id).find((trace) => trace.kind === "context" && trace.name === "compact");
    const data = compact?.data && typeof compact.data === "object" ? (compact.data as Record<string, number>) : undefined;
    const file = path.join(user.workspacePath, "note.txt");
    const body = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const recordKeepsCritical = !long || (transcript.includes("MIDDLE-ONLY") && transcript.includes("leave existing files alone"));
    const ok = task.status === "succeeded" && body.trim() === "pear" && recordKeepsCritical && (long ? compactRequests === Boolean(compact) : !compact);
    return {
      id,
      mode: compactRequests ? "on" : "off",
      ok,
      status: task.status,
      durationMs: Date.now() - started,
      compacted: Boolean(compact),
      beforeChars: data?.beforeChars ?? 0,
      afterChars: data?.afterChars ?? 0,
      beforeTokens: data?.beforeTokens ?? 0,
      afterTokens: data?.afterTokens ?? 0,
      recordKeepsCritical,
      detail: ok ? "pear written and the session record kept its earlier text" : `status ${task.status}; file ${body.trim() || "missing"}`,
    };
  } finally {
    await harness.stop();
  }
}

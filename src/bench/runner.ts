import fs from "node:fs";
import path from "node:path";
import { Harness } from "../agent/runtime.js";
import type { LincoConfig } from "../config.js";
import { zeroUsage, type ScriptStep, scriptedStream, SCRIPT_MODEL } from "../llm/scripted.js";
import type { Task } from "../types.js";

export interface BenchScenario {
  id: string;
  group: string;
  prompt: string;
  steps: ScriptStep[];
  prepare?: (workspace: string) => void;
  grade: (workspace: string, task: Task) => string | undefined;
}

export interface BenchRow {
  id: string;
  group: string;
  ok: boolean;
  status: string;
  durationMs: number;
  detail: string;
}

const usage = zeroUsage({
  input: 100,
  output: 20,
  cacheRead: 400,
  cacheWrite: 0,
  totalTokens: 520,
  cost: { input: 0.00003, output: 0.000024, cacheRead: 0.0000024, cacheWrite: 0, total: 0.0000564 },
});

const listSource = `
const listed = await tools.fs_list({ path: "." });
await tools.fs_write({ path: "listed.json", content: JSON.stringify(listed) });
return listed.entries.length;
`;

export const offlineScenarios: BenchScenario[] = [
  {
    id: "write-note",
    group: "files",
    prompt: "Create note.txt containing hello.",
    steps: [
      { calls: [{ name: "fs_write", arguments: { path: "note.txt", content: "hello" } }], usage },
      { text: "wrote note.txt", usage },
    ],
    grade: (workspace, task) => {
      const file = path.join(workspace, "note.txt");
      if (task.status !== "succeeded") return `status ${task.status}`;
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== "hello") return "note.txt was not written";
      return undefined;
    },
  },
  {
    id: "code-list",
    group: "code-mode",
    prompt: "List the workspace through code mode.",
    steps: [
      {
        calls: [{ name: "code_run", arguments: { source: listSource } }],
        usage,
      },
      { text: "listed the workspace", usage },
    ],
    prepare: (workspace) => fs.writeFileSync(path.join(workspace, "seed.txt"), "seed"),
    grade: (workspace, task) => {
      if (task.status !== "succeeded") return `status ${task.status}`;
      const listed = path.join(workspace, "listed.json");
      if (!fs.existsSync(listed) || !fs.readFileSync(listed, "utf8").includes("seed.txt")) {
        return "code mode did not record the workspace listing";
      }
      return undefined;
    },
  },
  {
    id: "delete-needs-approval",
    group: "security",
    prompt: "Delete note.txt.",
    steps: [
      { calls: [{ name: "fs_delete", arguments: { path: "note.txt" } }], usage },
      { text: "this turn should not run", usage },
    ],
    prepare: (workspace) => fs.writeFileSync(path.join(workspace, "note.txt"), "keep"),
    grade: (workspace, task) => {
      if (task.status !== "waiting_approval") return `expected waiting_approval, got ${task.status}`;
      if (fs.readFileSync(path.join(workspace, "note.txt"), "utf8") !== "keep") return "file changed before approval";
      return undefined;
    },
  },
];

export async function runOfflineBench(config: Pick<LincoConfig, "dataDir" | "skillsDir">): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  for (const scenario of offlineScenarios) {
    const harness = new Harness({
      config: {
        dataDir: path.join(config.dataDir, scenario.id),
        skillsDir: config.skillsDir,
        host: "127.0.0.1",
        port: 0,
        workerCount: 2,
        maxTurns: 8,
        model: "deepseek-flash",
        compactMaxChars: 180_000,
        compactRequests: true,
        schedulerIntervalMs: 60_000,
      },
      model: SCRIPT_MODEL,
      streamFn: scriptedStream(scenario.steps),
    });
    harness.start();
    const started = Date.now();
    try {
      const user = harness.createUser(scenario.id);
      scenario.prepare?.(user.workspacePath);
      const session = harness.createSession(user.id);
      const task = await harness.submit(session.id, scenario.prompt, { kind: "bench", waitMs: 5_000 });
      const detail = scenario.grade(user.workspacePath, task);
      rows.push({
        id: scenario.id,
        group: scenario.group,
        ok: detail === undefined,
        status: task.status,
        durationMs: Date.now() - started,
        detail: detail ?? "ok",
      });
    } finally {
      await harness.stop();
    }
  }
  return rows;
}

/**
 * One live check against DeepSeek. The scripted bench above is the default because it does not spend tokens.
 * This grades a real tool choice: the file must exist and contain `hello`.
 */
export async function runLiveHello(config: LincoConfig): Promise<BenchRow> {
  if (!config.apiKey) throw new Error("DEEPSEEK_API_KEY is required for a live bench");
  const harness = new Harness({ config });
  harness.start();
  const started = Date.now();
  try {
    const user = harness.createUser("live");
    const session = harness.createSession(user.id);
    const task = await harness.submit(
      session.id,
      "Create hello.txt in the workspace. The file must contain exactly hello and nothing else.",
      { kind: "bench", waitMs: 120_000, maxAttempts: 1 },
    );
    const file = path.join(user.workspacePath, "hello.txt");
    const actual = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const ok = task.status === "succeeded" && actual === "hello";
    return {
      id: "live-hello",
      group: "live",
      ok,
      status: task.status,
      durationMs: Date.now() - started,
      detail: ok ? "ok" : `status ${task.status}; file ${JSON.stringify(actual)}; error ${task.error ?? ""}`,
    };
  } finally {
    await harness.stop();
  }
}

import readline from "node:readline";
import vm from "node:vm";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { clip } from "../json.js";
import { sandboxBackend, startIsolated } from "../security/isolate.js";
import { approvalHash, assess } from "../security/policy.js";
import { defineTool } from "./define.js";
import { error, text } from "./files.js";
import type { ToolHost } from "./host.js";

type ToolInvoker = (name: string, args: unknown) => Promise<unknown>;

export function codeRunTool(host: ToolHost, invoke: ToolInvoker): AgentTool {
  return defineTool<{ source: string; timeoutMs?: number }>({
    name: "code_run",
    label: "Code mode",
    description:
      "Run a short async JavaScript snippet. Call workspace tools through the `tools` object, for example `return await tools.fs_list({ path: '.' })`. No require, process, or filesystem access except through tools.",
    parameters: Type.Object({
      source: Type.String(),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      if (params.source.length > 20_000) return error("source exceeds 20000 characters");
      const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 5_000, 100), 20_000);
      try {
        const value =
          host.sandbox === "require"
            ? await runIsolated(params.source, invoke, timeoutMs, host.workspaceRoot)
            : await runInSandbox(params.source, invoke, timeoutMs);
        return text(clip(JSON.stringify(value ?? null), 20_000), { value: jsonValue(value) });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return error(message);
      }
    },
  });
}

export function guardedInvoke(host: ToolHost, tools: AgentTool[]): ToolInvoker {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return async (name, args) => {
    if (name === "code_run") throw new Error("code_run cannot call itself");
    const tool = byName.get(name);
    if (!tool) throw new Error(`unknown tool ${name}`);
    const assessment = assess(name, args, host.workspaceRoot);
    if (assessment.action === "deny") throw new Error(assessment.reason);
    if (assessment.action === "approve") {
      const hash = approvalHash(name, args);
      if (!host.db.hasGrant(host.taskId, hash)) {
        host.db.createApproval({
          taskId: host.taskId,
          toolName: name,
          args,
          argsHash: hash,
          risk: assessment.risk,
          reason: assessment.reason,
          claim: host.claim,
        });
        host.markApproval();
        throw new Error(assessment.reason);
      }
    }
    const result = await tool.execute(`code_${name}`, args as never, host.signal);
    if (result.isError) {
      const message = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
      throw new Error(message || `${name} failed`);
    }
    return result.details;
  };
}

const RUNNER = `
import vm from "node:vm";
import readline from "node:readline";
const pending = new Map();
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === "result") {
    const found = pending.get(msg.id);
    if (found) found(msg);
    return;
  }
  if (msg.type === "start") {
    run(msg.source, msg.timeoutMs).catch((error) => {
      process.stdout.write(JSON.stringify({ type: "done", ok: false, error: String(error && error.message || error) }) + "\\n");
      process.exit(0);
    });
  }
});
function ask(name, args) {
  const id = Math.random().toString(16).slice(2);
  process.stdout.write(JSON.stringify({ type: "call", id, name, args }) + "\\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tool call timed out")), 20000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      pending.delete(id);
      if (!msg.ok) reject(new Error(msg.error || "tool failed"));
      else resolve(msg.value);
    });
  });
}
async function run(source, timeoutMs) {
  const tools = new Proxy({}, { get(_target, property) {
    if (typeof property !== "string") return undefined;
    return (args) => ask(property, args ?? {});
  }});
  const context = vm.createContext({ tools, JSON, Math, Number, String, Boolean, Array, Object, Promise });
  const script = new vm.Script("(async () => {\\n" + source + "\\n})()", { filename: "linco-code-mode.js" });
  const produced = script.runInContext(context, { timeout: Math.min(timeoutMs, 1000) });
  const value = await Promise.race([
    Promise.resolve(produced),
    new Promise((_, reject) => setTimeout(() => reject(new Error("code_run timed out")), timeoutMs)),
  ]);
  process.stdout.write(JSON.stringify({ type: "done", ok: true, value }) + "\\n");
  process.exit(0);
}
`;

async function runIsolated(source: string, invoke: ToolInvoker, timeoutMs: number, workspace: string): Promise<unknown> {
  if (!sandboxBackend()) throw new Error("sandbox is not available on this host; refusing to run");
  const started = startIsolated({
    argv: [process.execPath, "--input-type=module", "-e", RUNNER],
    cwd: workspace,
    timeoutMs: timeoutMs + 1_000,
    mode: "require",
  });
  if (!started.child) {
    const failed = await started.finished;
    throw new Error(failed.stderr || "sandbox refused to run");
  }
  const child = started.child;
  let settled = false;
  const result = new Promise<unknown>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const rl = readline.createInterface({ input: child.stdout!, terminal: false });
    rl.on("line", (line) => {
      let msg: { type?: string; id?: string; name?: string; args?: unknown; ok?: boolean; value?: unknown; error?: string };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "call" && msg.id && msg.name) {
        void invoke(msg.name, msg.args).then(
          (value) => child.stdin?.write(`${JSON.stringify({ type: "result", id: msg.id, ok: true, value })}\n`),
          (caught: unknown) =>
            child.stdin?.write(
              `${JSON.stringify({ type: "result", id: msg.id, ok: false, error: caught instanceof Error ? caught.message : String(caught) })}\n`,
            ),
        );
        return;
      }
      if (msg.type === "done") {
        finish(() => (msg.ok ? resolve(msg.value) : reject(new Error(msg.error || "code_run failed"))));
      }
    });
    void started.finished.then((finished) => {
      finish(() => reject(new Error(finished.timedOut ? "code_run timed out" : finished.stderr || `code_run exited ${finished.exitCode}`)));
    });
  });
  child.stdin?.write(`${JSON.stringify({ type: "start", source, timeoutMs })}\n`);
  try {
    return await result;
  } finally {
    child.kill("SIGKILL");
  }
}

async function runInSandbox(source: string, invoke: ToolInvoker, timeoutMs: number): Promise<unknown> {
  const tools = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        return (args: unknown) => invoke(property, args ?? {});
      },
    },
  );
  const context = vm.createContext({ tools, JSON, Math, Number, String, Boolean, Array, Object, Promise });
  const script = new vm.Script(`(async () => {\n${source}\n})()`, { filename: "linco-code-mode.js" });
  const produced: unknown = script.runInContext(context, { timeout: Math.min(timeoutMs, 1_000) });
  return await Promise.race([
    Promise.resolve(produced),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("code_run timed out")), timeoutMs);
    }),
  ]);
}

function jsonValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as unknown;
  } catch {
    return null;
  }
}

import vm from "node:vm";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { clip } from "../json.js";
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
        const value = await runInSandbox(params.source, invoke, timeoutMs);
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

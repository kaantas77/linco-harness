import type { AgentTool } from "@earendil-works/pi-agent-core";
import { codeRunTool } from "../tools/code-mode.js";
import { fileTools } from "../tools/files.js";
import type { ToolHost } from "../tools/host.js";

const BARE_NAMES = new Set(["fs_list", "fs_read", "fs_write", "fs_edit"]);

/** File and code tools for a plain Pi agent. No approval gate, memory, skills, or task queue. */
export function createBareTools(workspaceRoot: string, signal: AbortSignal): AgentTool[] {
  const host = { workspaceRoot, signal } as ToolHost;
  const files = fileTools(host).filter((tool) => BARE_NAMES.has(tool.name));
  const invoke = async (name: string, args: unknown) => {
    const tool = files.find((item) => item.name === name);
    if (!tool) throw new Error(`unknown tool ${name}`);
    const result = await tool.execute(`bare_${name}`, args as never, signal);
    if (result.isError) {
      const message = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
      throw new Error(message || `${name} failed`);
    }
    return result.details;
  };
  return [...files, codeRunTool(host, invoke)];
}

export const BARE_SYSTEM_PROMPT = [
  "You complete the user's task by calling tools.",
  "Do not claim a file changed unless a tool result says so.",
  "Follow the requested tool and the exact file content.",
  "Stop when the task is done.",
].join("\n");

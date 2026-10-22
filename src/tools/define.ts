import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

export function defineTool<T>(tool: {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  executionMode?: "parallel" | "sequential";
  execute: (toolCallId: string, params: T, signal?: AbortSignal) => Promise<unknown>;
}): AgentTool {
  return tool as AgentTool;
}

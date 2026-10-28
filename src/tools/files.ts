import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { clip } from "../json.js";
import { localFiles } from "./local-files.js";
import { defineTool } from "./define.js";
import type { ToolHost } from "./host.js";

const READ_LIMIT = 200_000;

export function fileTools(host: ToolHost): AgentTool[] {
  const files = host.files ?? localFiles(host.workspaceRoot);
  return [
    defineTool<{ path?: string }>({
      name: "fs_list",
      label: "List files",
      description: "List files and directories inside the user workspace.",
      parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Relative directory. Defaults to the workspace root." })) }),
      executionMode: "parallel",
      execute: async (_id, params) => {
        try {
          const entries = await files.list(params.path ?? ".");
          return text(JSON.stringify({ path: params.path ?? ".", entries }), { entries });
        } catch (caught) {
          return error(caught instanceof Error ? caught.message : String(caught));
        }
      },
    }),
    defineTool<{ path: string }>({
      name: "fs_read",
      label: "Read file",
      description: "Read a UTF-8 text file inside the user workspace.",
      parameters: Type.Object({ path: Type.String() }),
      executionMode: "parallel",
      execute: async (_id, params) => {
        try {
          const file = await files.read(params.path);
          return text(clip(file.text, READ_LIMIT), { path: params.path, bytes: file.bytes });
        } catch (caught) {
          return error(caught instanceof Error ? caught.message : String(caught));
        }
      },
    }),
    defineTool<{ path: string; content: string }>({
      name: "fs_write",
      label: "Write file",
      description: "Create or replace a UTF-8 text file inside the user workspace.",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        if (params.content.length > 1_000_000) return error("content exceeds 1000000 characters");
        try {
          const written = await files.write(params.path, params.content);
          return text(`wrote ${params.path}`, { path: params.path, bytes: written.bytes });
        } catch (caught) {
          return error(caught instanceof Error ? caught.message : String(caught));
        }
      },
    }),
    defineTool<{ path: string; old: string; new: string }>({
      name: "fs_edit",
      label: "Edit file",
      description: "Replace one unique snippet in a workspace file.",
      parameters: Type.Object({ path: Type.String(), old: Type.String(), new: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        try {
          await files.edit(params.path, params.old, params.new);
          return text(`edited ${params.path}`, { path: params.path });
        } catch (caught) {
          return error(caught instanceof Error ? caught.message : String(caught));
        }
      },
    }),
    defineTool<{ path: string }>({
      name: "fs_delete",
      label: "Delete file",
      description: "Delete one file inside the workspace. Requires user approval before it runs.",
      parameters: Type.Object({ path: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        try {
          await files.remove(params.path);
          return text(`deleted ${params.path}`, { path: params.path });
        } catch (caught) {
          return error(caught instanceof Error ? caught.message : String(caught));
        }
      },
    }),
  ];
}

export function text(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
}

export function error(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details, isError: true };
}

import type { AgentTool } from "@earendil-works/pi-agent-core";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { clip } from "../json.js";
import { resolveInside } from "../security/workspace.js";
import { defineTool } from "./define.js";
import type { ToolHost } from "./host.js";

const READ_LIMIT = 200_000;

export function fileTools(host: ToolHost): AgentTool[] {
  return [
    defineTool<{ path?: string }>({
      name: "fs_list",
      label: "List files",
      description: "List files and directories inside the user workspace.",
      parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Relative directory. Defaults to the workspace root." })) }),
      executionMode: "parallel",
      execute: async (_id, params) => {
        const dir = resolveInside(host.workspaceRoot, params.path ?? ".");
        const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file",
        }));
        return text(JSON.stringify({ path: params.path ?? ".", entries }), { entries });
      },
    }),
    defineTool<{ path: string }>({
      name: "fs_read",
      label: "Read file",
      description: "Read a UTF-8 text file inside the user workspace.",
      parameters: Type.Object({ path: Type.String() }),
      executionMode: "parallel",
      execute: async (_id, params) => {
        const file = resolveInside(host.workspaceRoot, params.path);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return error(`file not found: ${params.path}`);
        const raw = fs.readFileSync(file, "utf8");
        return text(clip(raw, READ_LIMIT), { path: params.path, bytes: Buffer.byteLength(raw) });
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
        const file = resolveInside(host.workspaceRoot, params.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, params.content);
        return text(`wrote ${params.path}`, { path: params.path, bytes: Buffer.byteLength(params.content) });
      },
    }),
    defineTool<{ path: string; old: string; new: string }>({
      name: "fs_edit",
      label: "Edit file",
      description: "Replace one unique snippet in a workspace file.",
      parameters: Type.Object({ path: Type.String(), old: Type.String(), new: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        if (!params.old) return error("old snippet is empty");
        const file = resolveInside(host.workspaceRoot, params.path);
        if (!fs.existsSync(file)) return error(`file not found: ${params.path}`);
        const current = fs.readFileSync(file, "utf8");
        const hits = current.split(params.old).length - 1;
        if (hits === 0) return error("snippet not found");
        if (hits > 1) return error("snippet is not unique");
        const next = current.replace(params.old, params.new);
        fs.writeFileSync(file, next);
        return text(`edited ${params.path}`, { path: params.path });
      },
    }),
    defineTool<{ path: string }>({
      name: "fs_delete",
      label: "Delete file",
      description: "Delete one file inside the workspace. Requires user approval before it runs.",
      parameters: Type.Object({ path: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const file = resolveInside(host.workspaceRoot, params.path);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return error(`file not found: ${params.path}`);
        fs.rmSync(file);
        return text(`deleted ${params.path}`, { path: params.path });
      },
    }),
  ];
}

export function text(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
}

export function error(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: {}, isError: true };
}

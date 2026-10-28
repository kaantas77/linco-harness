import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { quoteShell, workspaceRelative } from "../boat/paths.js";
import { assessShell } from "../security/policy.js";
import { defineTool } from "./define.js";
import { error, text } from "./files.js";
import { localFiles } from "./local-files.js";
import type { ToolHost } from "./host.js";

/** Writes a workspace file and runs that file. A non-zero exit or a timeout is returned as an error. */
export function codeWriteRunTool(host: ToolHost): AgentTool {
  const files = host.files ?? localFiles(host.workspaceRoot);
  return defineTool<{ path: string; source: string; command?: string }>({
    name: "code_write_run",
    label: "Write and run",
    description: "Write a source file in the workspace and run that file. The result includes the exit code and stdout. A timeout or a non-zero exit is an error.",
    parameters: Type.Object({
      path: Type.String(),
      source: Type.String(),
      command: Type.Optional(Type.String({ description: "Command that runs this file. Defaults to node or python3." })),
    }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      let relative = "";
      try {
        relative = workspaceRelative(params.path);
      } catch (caught) {
        return error(caught instanceof Error ? caught.message : String(caught));
      }
      if (!params.source.trim() || params.source.length > 100_000) return error("source is empty or too long");
      const command = (params.command?.trim() || defaultCommand(host.workspaceRoot, relative)).trim();
      const base = relative.split("/").pop() ?? "";
      if (!base || !command.includes(base)) return error("the command does not run this file");
      const assessment = assessShell(command, host.workspaceRoot);
      if (assessment.action === "deny") return error(assessment.reason);
      try {
        await files.write(relative, params.source);
        const result = await host.computer.exec({
          command,
          cwd: host.workspaceRoot,
          timeoutMs: 30_000,
          signal: host.signal,
        });
        const body = [`exit ${result.exitCode}${result.timedOut ? " timeout" : ""}`, result.stdout, result.stderr].filter((part) => part.trim()).join("\n");
        if (result.timedOut || result.exitCode !== 0) return error(body || "command failed");
        return text(body || "exit 0", { exitCode: result.exitCode, path: relative });
      } catch (caught) {
        return error(caught instanceof Error ? caught.message : String(caught));
      }
    },
  });
}

function defaultCommand(root: string, relative: string): string {
  const absolute = path.posix.join(root.replaceAll("\\", "/"), relative);
  const runner = relative.endsWith(".py") ? "python3" : "node";
  return `${runner} ${quoteShell(absolute)}`;
}

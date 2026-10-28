import { describe, expect, it } from "vitest";
import { assess } from "../src/security/policy.js";
import { codeWriteRunTool } from "../src/tools/code-write.js";
import type { ToolHost } from "../src/tools/host.js";

describe("code write run", () => {
  it("writes the file, runs that path, and keeps a timeout visible", async () => {
    const commands: string[] = [];
    let written = "";
    const tool = codeWriteRunTool({
      workspaceRoot: "/home/user/linco",
      signal: new AbortController().signal,
      files: {
        write: async (_path: string, content: string) => {
          written = content;
          return { bytes: content.length };
        },
      },
      computer: {
        id: "test",
        exec: async (command: { command: string }) => {
          commands.push(command.command);
          return { exitCode: 0, stdout: "", stderr: "boat command timed out", timedOut: true };
        },
      },
    } as ToolHost);
    const result = await tool.execute("1", { path: "proof/main.mjs", source: "console.log('hi')" });
    expect(written).toContain("console.log");
    expect(commands[0]).toContain("proof/main.mjs");
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toMatch(/timeout/);
  });

  it("asks before a destructive command and denies sudo", () => {
    expect(assess("code_write_run", { command: "rm proof/main.mjs" }, "/home/user/linco").action).toBe("approve");
    expect(assess("code_write_run", { command: "sudo reboot" }, "/home/user/linco").action).toBe("deny");
    expect(assess("desktop_edit_file", { path: "proof/a.txt", text: "hi" }, "/tmp/work").action).toBe("approve");
  });
});

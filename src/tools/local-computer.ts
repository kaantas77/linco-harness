import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ComputerProvider, ExecResult } from "./computer.js";

const OUTPUT_LIMIT = 100_000;

/** Process runner used by `shell_exec`. This is not an OS sandbox. Policy plus cwd and a clean env are the phase-1 boundary. */
export class LocalComputerProvider implements ComputerProvider {
  readonly id = "local-process";

  exec(input: { command: string; cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<ExecResult> {
    fs.mkdirSync(input.cwd, { recursive: true });
    const tmp = path.join(input.cwd, ".tmp");
    fs.mkdirSync(tmp, { recursive: true });
    return new Promise((resolve) => {
      const child = spawn(input.command, {
        cwd: input.cwd,
        shell: true,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: input.cwd,
          TMPDIR: tmp,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
        },
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, input.timeoutMs);
      const onAbort = () => child.kill("SIGKILL");
      input.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = trimOutput(stdout + chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = trimOutput(stderr + chunk);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode: 1, stdout, stderr: trimOutput(`${stderr}\n${error.message}`), timedOut });
      });
    });
  }
}

function trimOutput(value: string): string {
  if (value.length <= OUTPUT_LIMIT) return value;
  return `${value.slice(0, OUTPUT_LIMIT)}\n…[truncated]`;
}

import type { ComputerProvider, ExecResult } from "./computer.js";
import { limitCommand, startIsolated, type SandboxMode } from "../security/isolate.js";

/** Runs `shell_exec` inside the OS sandbox when sandbox mode is require. */
export class LocalComputerProvider implements ComputerProvider {
  readonly id = "local-process";

  constructor(private readonly sandbox: SandboxMode) {}

  exec(input: { command: string; cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<ExecResult> {
    const started = startIsolated({
      argv: ["/bin/sh", "-c", limitCommand(input.command)],
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      mode: this.sandbox,
    });
    return started.finished;
  }
}

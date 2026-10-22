export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ComputerProvider {
  readonly id: string;
  exec(input: { command: string; cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<ExecResult>;
}

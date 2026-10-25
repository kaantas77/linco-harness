import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExecResult } from "../tools/computer.js";

const OUTPUT_LIMIT = 100_000;

export type SandboxMode = "require" | "off";

export function sandboxBackend(): "seatbelt" | "bwrap" | null {
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) return "seatbelt";
  if (process.platform === "linux" && fs.existsSync("/usr/bin/bwrap")) return "bwrap";
  return null;
}

export function startIsolated(input: {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  mode: SandboxMode;
}): { child: ChildProcess | null; finished: Promise<ExecResult> } {
  if (input.argv.length === 0 || !input.argv[0]) {
    return refused("missing command");
  }
  const backend = sandboxBackend();
  if (input.mode === "require" && !backend) return refused("sandbox is not available on this host; refusing to run");
  fs.mkdirSync(input.cwd, { recursive: true });
  fs.mkdirSync(path.join(input.cwd, ".tmp"), { recursive: true });
  const cwd = fs.realpathSync(input.cwd);
  const argv = input.mode === "off" || !backend ? input.argv : wrap(backend, cwd, input.argv);
  const program = argv[0];
  if (!program) return refused("missing command");
  const child = spawn(program, argv.slice(1), {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      TMPDIR: path.join(cwd, ".tmp"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { child, finished: collect(child, input.timeoutMs, input.signal) };
}

export function limitCommand(command: string): string {
  return [
    "ulimit -H -t 30 >/dev/null 2>&1",
    "ulimit -H -u 64 >/dev/null 2>&1",
    "ulimit -H -n 128 >/dev/null 2>&1",
    "ulimit -H -f 102400 >/dev/null 2>&1",
    command,
  ].join("; ");
}

function wrap(backend: "seatbelt" | "bwrap", workspace: string, argv: string[]): string[] {
  if (backend === "seatbelt") return ["/usr/bin/sandbox-exec", "-p", seatbeltProfile(workspace), "--", ...argv];
  return ["/usr/bin/bwrap", ...bwrapArgs(workspace), "--", ...argv];
}

function seatbeltProfile(workspace: string): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow file-map-executable)",
    "(allow file-ioctl)",
    "(allow file-read*)",
    `(allow file-write* (subpath ${scheme(workspace)}))`,
    '(deny file-read-data (subpath "/etc"))',
    '(deny file-read-data (subpath "/Users"))',
    '(deny file-read-data (subpath "/private"))',
    `(allow file-read-data file-write* (subpath ${scheme(workspace)}))`,
    `(allow file-read-data (subpath ${scheme(runtimeRoot())}))`,
  ];
  for (const dir of ["/usr", "/bin", "/sbin", "/System", "/Library", "/opt", "/dev", "/private/var/select"]) {
    if (fs.existsSync(dir)) lines.push(`(allow file-read-data (subpath ${scheme(dir)}))`);
  }
  lines.push("(deny network*)");
  return `${lines.join("\n")}\n`;
}

function runtimeRoot(): string {
  const bin = path.dirname(fs.realpathSync(process.execPath));
  return path.basename(bin) === "bin" ? path.dirname(bin) : bin;
}

export function bwrapArgs(workspace: string): string[] {
  const args = ["--unshare-all", "--die-with-parent", "--new-session"];
  for (const dir of ["/usr", "/bin", "/lib", "/lib64"]) {
    if (fs.existsSync(dir)) args.push("--ro-bind", dir, dir);
  }
  const nodeDir = path.dirname(fs.realpathSync(process.execPath));
  const covered = ["/usr", "/bin", "/lib", "/lib64"].some((dir) => nodeDir === dir || nodeDir.startsWith(`${dir}/`));
  if (!covered && fs.existsSync(nodeDir)) args.push("--ro-bind", nodeDir, nodeDir);
  args.push("--proc", "/proc", "--dev", "/dev");
  args.push("--bind", workspace, workspace, "--chdir", workspace);
  args.push("--setenv", "HOME", workspace, "--setenv", "TMPDIR", path.join(workspace, ".tmp"));
  return args;
}

function scheme(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function refused(message: string): { child: null; finished: Promise<ExecResult> } {
  return { child: null, finished: Promise.resolve({ exitCode: 1, stdout: "", stderr: message, timedOut: false }) };
}

function collect(child: ChildProcess, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = trimOutput(stdout + chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = trimOutput(stderr + chunk);
    });
    const finish = (code: number) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: code, stdout, stderr: cleanStderr(stderr), timedOut });
    };
    child.on("close", (code) => finish(code ?? 1));
    child.on("error", (error) => {
      stderr = trimOutput(`${stderr}\n${error.message}`);
      finish(1);
    });
  });
}

function cleanStderr(value: string): string {
  return value
    .split("\n")
    .filter((line) => !line.includes("sandbox-exec:") && !line.includes("sandbox_apply"))
    .join("\n")
    .trim();
}

function trimOutput(value: string): string {
  if (value.length <= OUTPUT_LIMIT) return value;
  return `${value.slice(0, OUTPUT_LIMIT)}\n…[truncated]`;
}

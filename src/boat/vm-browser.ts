import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { quoteShell } from "./paths.js";

const SCRIPT_PATH = "/home/user/linco/.linco/vm-browser.mjs";
const PROFILE = "/home/user/linco/.linco/chrome-profile";

export type VmBrowserRequest =
  | { op: "goto" | "navigate" | "openRead"; url: string; expectedTitle?: string; expectedText?: string }
  | { op: "read" | "snapshot" | "screenshot" | "grab" | "hold" }
  | { op: "fill"; url: string; name: string; text: string; submit?: boolean }
  | { op: "clickRef" | "fillRef" | "selectRef"; ref: string; snapshotId: number; text?: string; value?: string }
  | { op: "showFile"; relative: string };

export interface AxElementResult {
  ref: string;
  role: string;
  name: string;
  disabled: boolean;
  filled?: boolean;
}

export interface VmBrowserResult {
  ok: boolean;
  engine: string;
  op: string;
  title?: string;
  url?: string;
  text?: string;
  error?: string;
  shot?: string;
  bytes?: number;
  width?: number;
  height?: number;
  captureTool?: string;
  verified?: boolean;
  snapshot?: {
    snapshotId: number;
    targetId: string;
    url: string;
    title: string;
    elements: AxElementResult[];
  };
}

/** The script that Boat runs. Loading it here does not launch a browser. */
export function vmBrowserScript(): string {
  const beside = fileURLToPath(new URL("./vm-browser.mjs", import.meta.url));
  const candidates = [beside, path.resolve("src/boat/vm-browser.mjs")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error("vm browser script is missing");
}

export function vmBrowserPrepareCommand(): string {
  const encoded = Buffer.from(vmBrowserScript()).toString("base64");
  return [
    "mkdir -p /home/user/linco/.linco /home/user/linco/proof",
    `printf %s ${quoteShell(encoded)} | base64 -d > ${SCRIPT_PATH}`,
    `test -d ${PROFILE} || mkdir -p ${PROFILE}`,
  ].join(" && ");
}

export function vmBrowserInstallCommand(): string {
  return [
    "if [ -d /home/user/linco/.linco/node_modules/playwright-core ]; then exit 0; fi",
    "cd /home/user/linco/.linco",
    "npm init -y >/tmp/linco-npm-init.txt 2>&1",
    "npm install playwright-core@1.64.1 --omit=dev --no-fund --no-audit >/tmp/linco-npm-install.txt 2>&1",
  ].join(" && ");
}

export function vmBrowserServeCommand(): string {
  const script = [
    `if node ${SCRIPT_PATH} ping; then exit 0; fi`,
    "rm -f /home/user/linco/.linco/browser.sock",
    "DISPLAY=${DISPLAY:-:0}",
    "export DISPLAY",
    `nohup node ${SCRIPT_PATH} serve >> /home/user/linco/.linco/browser.log 2>&1 &`,
    "i=0",
    "while [ \"$i\" -lt 80 ]; do",
    `  if node ${SCRIPT_PATH} ping; then exit 0; fi`,
    "  i=$((i+1))",
    "  sleep 0.5",
    "done",
    "echo browser daemon did not start >&2",
    "tail -n 40 /home/user/linco/.linco/browser.log >&2 || true",
    "exit 1",
  ].join("\n");
  const encoded = Buffer.from(script).toString("base64");
  return `printf %s ${quoteShell(encoded)} | base64 -d > /home/user/linco/.linco/serve.sh && sh /home/user/linco/.linco/serve.sh`;
}

export function vmBrowserCallCommand(request: VmBrowserRequest): string {
  const encoded = Buffer.from(JSON.stringify(request)).toString("base64");
  return `node ${SCRIPT_PATH} call ${quoteShell(encoded)}`;
}

export function parseVmBrowserResult(stdout: string): VmBrowserResult {
  const line = stdout.trim().split("\n").filter((item) => item.startsWith("{")).at(-1) ?? "";
  let parsed: VmBrowserResult;
  try {
    parsed = JSON.parse(line) as VmBrowserResult;
  } catch {
    throw new Error("vm browser returned no result");
  }
  if (!parsed.ok) throw new Error(parsed.error || "vm browser failed");
  return parsed;
}

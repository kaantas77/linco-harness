import path from "node:path";
import { argsHash } from "../json.js";

export type Risk = "read" | "write" | "exec" | "network" | "destructive" | "payment";

export type Assessment =
  | { action: "allow"; risk: Risk }
  | { action: "approve"; risk: Risk; reason: string }
  | { action: "deny"; risk: Risk; reason: string };

const PAYMENT = /\b(stripe|paypal|checkout|wire transfer|iban)\b/i;

export function assess(toolName: string, args: unknown, workspaceRoot: string): Assessment {
  if (toolName === "shell_exec" || toolName === "code_write_run") return assessShell(readCommand(args) || "node script", workspaceRoot);
  if (toolName === "desktop_edit_file") {
    return { action: "approve", risk: "exec", reason: "Typing on the Boat desktop needs user approval." };
  }
  if (toolName === "desktop_click" || toolName === "desktop_type" || toolName === "desktop_window" || toolName === "desktop_browser") {
    return { action: "approve", risk: "exec", reason: "Desktop input on the Boat computer needs user approval." };
  }
  if (toolName === "vm_browser_goto" || toolName === "vm_browser_fill" || toolName === "browser_navigate" || toolName === "browser_open_read") {
    return { action: "approve", risk: "network", reason: "Navigating the Boat browser needs user approval." };
  }
  if (toolName === "desktop_batch") {
    return { action: "approve", risk: "exec", reason: "Desktop input on the Boat computer needs user approval." };
  }
  if (toolName === "fs_delete") {
    return { action: "approve", risk: "destructive", reason: "Deleting a file needs user approval." };
  }
  if (toolName === "code_run" && PAYMENT.test(readSource(args))) {
    return { action: "approve", risk: "payment", reason: "Code that mentions a payment needs user approval." };
  }
  return { action: "allow", risk: riskFor(toolName) };
}

export function approvalHash(toolName: string, args: unknown): string {
  return argsHash(toolName, args);
}

function riskFor(toolName: string): Risk {
  if (toolName.startsWith("browser_")) return "network";
  switch (toolName) {
    case "fs_write":
    case "fs_edit":
    case "memory_save":
    case "plan_write":
      return "write";
    case "web_fetch":
    case "jev_run":
      return "network";
    case "code_run":
    case "shell_exec":
      return "exec";
    case "task_spawn":
      return "exec";
    default:
      return "read";
  }
}

function readCommand(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

function readSource(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const source = (args as { source?: unknown }).source;
  return typeof source === "string" ? source : "";
}

export function assessShell(command: string, workspaceRoot: string): Assessment {
  const trimmed = command.trim();
  if (!trimmed) return { action: "deny", risk: "exec", reason: "Empty command." };
  if (trimmed.length > 4_000) return { action: "deny", risk: "exec", reason: "Command is too long." };
  if (controlPlaneBlocked(trimmed)) {
    return { action: "deny", risk: "destructive", reason: "Command is blocked by Linco policy." };
  }
  if (isHardDenied(trimmed)) {
    return { action: "deny", risk: "destructive", reason: "Command is blocked by Linco policy." };
  }
  if (escapesWorkspace(trimmed, workspaceRoot)) {
    return { action: "deny", risk: "destructive", reason: "Command references a path outside the workspace." };
  }
  if (PAYMENT.test(trimmed)) {
    return { action: "approve", risk: "payment", reason: "Payment commands need user approval." };
  }
  if (/\brm\b|\bunlink\b|\brmdir\b/.test(trimmed)) {
    return { action: "approve", risk: "destructive", reason: "Removing files needs user approval." };
  }
  return { action: "allow", risk: "exec" };
}

const BROWSER_BIN = /\b(google-chrome(?:-stable)?|chromium(?:-browser)?|chrome-headless-shell)\b/i;

/** The browser control socket, a Chrome launch, and metadata addresses. */
export function controlPlaneBlocked(command: string): boolean {
  return BROWSER_BIN.test(command) || /browser\.sock|vm-browser\.mjs|chrome-profile|remote-debugging|169\.254\.169\.254|metadata\.google(?:\.internal)?|\/\.linco(?:\/|\s|$)/i.test(command);
}

export function browserAppName(value: string): boolean {
  return /chrome|chromium/i.test(value);
}

/** Boat browser tools and desktop launches. Host Playwright tools keep their own rules. */
export function boatBrowserBlocked(toolName: string, args: unknown): boolean {
  if (toolName === "desktop_browser" || toolName.startsWith("vm_browser_")) return true;
  if (toolName === "desktop_window") return browserAppName(readApp(args));
  if (toolName === "desktop_batch") return /chrome|chromium|launch_app/i.test(JSON.stringify(args ?? ""));
  if (toolName === "shell_exec" || toolName === "code_write_run") return controlPlaneBlocked(`${readCommand(args)}\n${readSource(args)}`);
  return false;
}

export function desktopStartsBrowser(tool: string, args: Record<string, unknown>): boolean {
  if (tool === "browser_navigate" || tool === "browser_prepare" || tool === "get_browser_state") return true;
  if (tool !== "launch_app") return false;
  return browserAppName(JSON.stringify(args));
}

function readApp(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const app = (args as { app?: unknown }).app;
  return typeof app === "string" ? app : "";
}

function isHardDenied(command: string): boolean {
  return [
    /\bsudo\b/,
    /\b(shutdown|reboot|halt|poweroff)\b/,
    /\bmkfs\b/,
    /\bdd\b/,
    /:\(\)\s*\{/,
    /\b(curl|wget)\b[\s\S]*\|\s*(sh|bash|zsh)\b/,
    /\brm\b[\s\S]*\s\/(\s|$)/,
    /\brm\b[\s\S]*\s~(\/|\s|$)/,
  ].some((pattern) => pattern.test(command));
}

function escapesWorkspace(command: string, workspaceRoot: string): boolean {
  if (command.includes("..")) return true;
  const root = path.resolve(workspaceRoot);
  const matches = command.match(/(?:^|[\s"'`(=>])(\/[^\s"'`);|&<>]+)/g) ?? [];
  for (const match of matches) {
    const raw = match.trim().replace(/^[\s"'`(=>]+/, "");
    const resolved = path.resolve(raw);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return true;
  }
  return false;
}

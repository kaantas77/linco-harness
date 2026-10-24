import path from "node:path";
import { argsHash } from "../json.js";

export type Risk = "read" | "write" | "exec" | "network" | "destructive" | "payment";

export type Assessment =
  | { action: "allow"; risk: Risk }
  | { action: "approve"; risk: Risk; reason: string }
  | { action: "deny"; risk: Risk; reason: string };

const PAYMENT = /\b(stripe|paypal|checkout|wire transfer|iban)\b/i;

export function assess(toolName: string, args: unknown, workspaceRoot: string): Assessment {
  if (toolName === "shell_exec") return assessShell(readCommand(args), workspaceRoot);
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

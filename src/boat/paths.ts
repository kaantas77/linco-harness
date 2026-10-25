import path from "node:path";
import { WorkspaceEscapeError } from "../security/workspace.js";

/** Files the agent sees live here. Boat keeps `/home/user` across stop and resume. */
export const REMOTE_WORKSPACE = "/home/user/linco";
export const REMOTE_PREFIX = "linco";

export const RETENTION_NOTE =
  "A stopped Boat disk is kept for 14 days. /home/user is saved. /tmp, ~/.cache, and running processes are not. Resume uses the newest snapshot.";

/** Relative workspace path, with `..` and absolute paths rejected. */
export function workspaceRelative(input: string): string {
  if (!input || input.includes("\0")) throw new WorkspaceEscapeError(input || ".");
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) throw new WorkspaceEscapeError(input);
  const parts = input.split(/[\\/]+/).filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw new WorkspaceEscapeError(input);
  return parts.join("/");
}

/** Boat file APIs are relative to `/home/user`. */
export function boatFilePath(input: string): string {
  const relative = workspaceRelative(input || ".");
  return relative ? `${REMOTE_PREFIX}/${relative}` : REMOTE_PREFIX;
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

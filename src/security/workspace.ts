import fs from "node:fs";
import path from "node:path";

export class WorkspaceEscapeError extends Error {
  constructor(input: string) {
    super(`path escapes workspace: ${input}`);
    this.name = "WorkspaceEscapeError";
  }
}

/** Resolve `input` and reject anything that lands outside `root`, including symlink escapes. */
export function resolveInside(root: string, input: string): string {
  const rootReal = fs.realpathSync(path.resolve(root));
  const target = path.resolve(rootReal, input || ".");
  assertInside(rootReal, target, input);
  const existing = nearestExisting(target);
  const existingReal = fs.realpathSync(existing);
  assertInside(rootReal, existingReal, input);
  const suffix = path.relative(existing, target);
  return path.resolve(existingReal, suffix);
}

function assertInside(rootReal: string, candidate: string, input: string): void {
  const relative = path.relative(rootReal, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new WorkspaceEscapeError(input || ".");
}

function nearestExisting(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

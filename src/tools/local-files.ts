import fs from "node:fs";
import path from "node:path";
import { resolveInside } from "../security/workspace.js";

export interface WorkspaceFiles {
  list(relativePath: string): Promise<Array<{ name: string; type: "dir" | "file" }>>;
  read(relativePath: string): Promise<{ text: string; bytes: number }>;
  write(relativePath: string, content: string): Promise<{ bytes: number }>;
  edit(relativePath: string, oldText: string, newText: string): Promise<void>;
  remove(relativePath: string): Promise<void>;
}

export function localFiles(root: string): WorkspaceFiles {
  return {
    async list(relativePath) {
      const dir = resolveInside(root, relativePath || ".");
      return fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "dir" as const : "file" as const,
      }));
    },
    async read(relativePath) {
      const file = resolveInside(root, relativePath);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`file not found: ${relativePath}`);
      const text = fs.readFileSync(file, "utf8");
      return { text, bytes: Buffer.byteLength(text) };
    },
    async write(relativePath, content) {
      if (content.length > 1_000_000) throw new Error("content exceeds 1000000 characters");
      const file = resolveInside(root, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return { bytes: Buffer.byteLength(content) };
    },
    async edit(relativePath, oldText, newText) {
      const current = await this.read(relativePath);
      const next = replaceSnippet(current.text, oldText, newText);
      await this.write(relativePath, next);
    },
    async remove(relativePath) {
      const file = resolveInside(root, relativePath);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`file not found: ${relativePath}`);
      fs.rmSync(file);
    },
  };
}

export function replaceSnippet(current: string, oldText: string, newText: string): string {
  if (!oldText) throw new Error("old snippet is empty");
  const hits = current.split(oldText).length - 1;
  if (hits === 0) throw new Error("snippet not found");
  if (hits > 1) throw new Error("snippet is not unique");
  return current.replace(oldText, newText);
}

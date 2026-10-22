import type { LincoDb } from "../db/database.js";
import type { SkillCatalog } from "../skills/catalog.js";
import type { BrowserProvider } from "./browser.js";
import type { ComputerProvider } from "./computer.js";

export interface ToolHost {
  workspaceRoot: string;
  taskId: string;
  userId: string;
  sessionId: string;
  parentTaskId: string | null;
  systemPrompt: string;
  db: LincoDb;
  skills: SkillCatalog;
  browser: BrowserProvider;
  computer: ComputerProvider;
  signal: AbortSignal;
  markApproval: () => void;
}

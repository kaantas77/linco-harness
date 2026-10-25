import type { LincoDb } from "../db/database.js";
import type { SandboxMode } from "../security/isolate.js";
import type { SkillCatalog } from "../skills/catalog.js";
import type { TaskClaim } from "../types.js";
import type { DesktopObservation } from "../boat/client.js";
import type { DriverSchema } from "../boat/driver-schema.js";
import type { BrowserProvider } from "./browser.js";
import type { ComputerProvider } from "./computer.js";
import type { WorkspaceFiles } from "./local-files.js";

export interface DesktopBridge {
  acceptsImages: boolean;
  call(tool: string, args: Record<string, unknown>): Promise<DesktopObservation>;
  schema?: (name: string) => DriverSchema | undefined;
}

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
  files?: WorkspaceFiles;
  desktop?: DesktopBridge;
  signal: AbortSignal;
  claim: TaskClaim;
  allowLoopback: boolean;
  sandbox: SandboxMode;
  markApproval: () => void;
  /** Record a child the current turn will park on. Absent outside a live agent run. */
  parkChild?: (childId: string) => void;
}

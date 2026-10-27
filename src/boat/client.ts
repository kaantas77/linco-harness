import {
  BoatApi,
  Configuration,
  ResponseError,
  execCommand,
  readText,
  writeText,
} from "@boatdev/sdk";
import type { Sandbox } from "@boatdev/sdk";
import type { DriverSchema } from "./driver-schema.js";
import { parseSchemas } from "./driver-schema.js";
import { mcpCommand } from "./mcp.js";
import { quoteShell } from "./paths.js";
import { redactBoat } from "./redact.js";

export interface BoatSandboxView {
  id: string;
  state: string;
  error: string | null;
  dataExpiredAt: string | null;
}

export interface BoatCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface BoatUsageView {
  seconds: number;
  dollars: number;
  sandboxType: string;
}

export interface BoatSnapshotView {
  id: string;
  status: string;
}

export interface DesktopObservation {
  text: string;
  tree: string;
  image?: { data: string; mimeType: string };
  schemas?: DriverSchema[];
}

export type BoatMachineType = "small" | "default" | "large" | "xlarge";

export interface BoatClient {
  create(input: { idempotencyKey: string; type: BoatMachineType; ttlSeconds: number }): Promise<BoatSandboxView>;
  get(sandboxId: string): Promise<BoatSandboxView>;
  stop(sandboxId: string): Promise<void>;
  resume(sandboxId: string): Promise<void>;
  delete(sandboxId: string): Promise<void>;
  command(input: { sandboxId: string; command: string; cwd?: string; timeoutSeconds: number }): Promise<BoatCommandResult>;
  readText(sandboxId: string, path: string): Promise<string>;
  writeText(sandboxId: string, path: string, content: string): Promise<void>;
  list(sandboxId: string, path: string): Promise<Array<{ name: string; type: "dir" | "file" }>>;
  usage(sandboxId: string): Promise<BoatUsageView>;
  latestSnapshot(sandboxId: string): Promise<BoatSnapshotView | null>;
  desktop(sandboxId: string, tool: string, args: Record<string, unknown>): Promise<DesktopObservation>;
}

export class BoatFailure extends Error {
  readonly httpStatus: number | null;
  readonly code: string;

  constructor(message: string, detail: { httpStatus?: number | null; code?: string } = {}) {
    super(redactBoat(message));
    this.name = "BoatFailure";
    this.httpStatus = detail.httpStatus ?? null;
    this.code = detail.code ?? "";
  }
}

export function createBoatClient(input: { apiKey: string; basePath?: string }): BoatClient {
  const api = new BoatApi(
    new Configuration({
      basePath: input.basePath || "https://boat.dev/api/v1",
      accessToken: input.apiKey,
    }),
  );
  return new SdkBoatClient(api);
}

class SdkBoatClient implements BoatClient {
  constructor(private readonly api: BoatApi) {}

  async create(input: { idempotencyKey: string; type: BoatMachineType; ttlSeconds: number }): Promise<BoatSandboxView> {
    try {
      const limits = await this.api.limits({});
      const machine = (limits.machineTypes ?? []).find((item) => item.type === input.type);
      if (machine && !machine.available) {
        throw new BoatFailure(`boat machine type ${input.type} is unavailable${machine.reason ? `: ${machine.reason}` : ""}`);
      }
      const created = await this.api.create({
        idempotencyKey: input.idempotencyKey,
        createSandboxRequest: { type: input.type, ttlSeconds: input.ttlSeconds, noEnv: true },
      });
      return mapSandbox(created.sandbox);
    } catch (error) {
      throw await asBoatFailure(error);
    }
  }

  async get(sandboxId: string): Promise<BoatSandboxView> {
    try {
      const info = await this.api.get({ sandboxId });
      return mapSandbox(info.sandbox);
    } catch (error) {
      throw await asBoatFailure(error);
    }
  }

  async stop(sandboxId: string): Promise<void> {
    try {
      await this.api.stop({ sandboxId });
    } catch (error) {
      throw await asBoatFailure(error);
    }
  }

  async resume(sandboxId: string): Promise<void> {
    try {
      await this.api.resume({ sandboxId, resumeRequest: { noEnv: true } });
    } catch (error) {
      throw await asBoatFailure(error);
    }
  }

  async delete(sandboxId: string): Promise<void> {
    try {
      await this.api.deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId });
    } catch (error) {
      throw await asBoatFailure(error);
    }
  }

  async command(input: { sandboxId: string; command: string; cwd?: string; timeoutSeconds: number }): Promise<BoatCommandResult> {
    try {
      const result = await execCommand(this.api, input.sandboxId, input.command, input.cwd, input.timeoutSeconds);
      if (!("stdout" in result)) throw new BoatFailure("boat command did not finish");
      return {
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      };
    } catch (error) {
      throw await asBoatFailure(error);
    }
  }

  async readText(sandboxId: string, path: string): Promise<string> {
    try {
      return await readText(this.api, sandboxId, path);
    } catch (error) {
      throw await asBoatFailure(error);
    }
  }

  async writeText(sandboxId: string, path: string, content: string): Promise<void> {
    try {
      await writeText(this.api, sandboxId, path, content);
    } catch (error) {
      throw await asBoatFailure(error);
    }
  }

  async list(sandboxId: string, path: string): Promise<Array<{ name: string; type: "dir" | "file" }>> {
    const script =
      'const fs=require("fs");const p=process.argv[1];const items=fs.readdirSync(p,{withFileTypes:true}).slice(0,200).map((e)=>({name:e.name,type:e.isDirectory()?"dir":"file"}));process.stdout.write(JSON.stringify(items));';
    const result = await this.command({
      sandboxId,
      command: `node -e ${quoteShell(script)} ${quoteShell(path)}`,
      timeoutSeconds: 15,
    });
    if (result.exitCode !== 0) throw new BoatFailure(result.stderr || "boat file list failed");
    const parsed = JSON.parse(result.stdout) as Array<{ name: string; type: "dir" | "file" }>;
    return parsed;
  }

  async usage(sandboxId: string): Promise<BoatUsageView> {
    try {
      const usage = await this.api.usage({ sandboxId });
      return { seconds: usage.seconds, dollars: usage.dollars, sandboxType: usage.sandboxType };
    } catch (error) {
      throw await asBoatFailure(error);
    }
  }

  async latestSnapshot(sandboxId: string): Promise<BoatSnapshotView | null> {
    try {
      const latest = await this.api.getLatestSandboxSnapshot({ sandboxId });
      if (!latest.snapshot) return null;
      return { id: latest.snapshot.id, status: latest.snapshot.status };
    } catch (error) {
      throw await asBoatFailure(error);
    }
  }

  async desktop(sandboxId: string, tool: string, args: Record<string, unknown>): Promise<DesktopObservation> {
    const result = await this.command({
      sandboxId,
      command: mcpCommand(tool, args),
      timeoutSeconds: 60,
    });
    if (result.timedOut) throw new BoatFailure("boat desktop driver timed out");
    const line = result.stdout.trim().split("\n").findLast((item) => item.startsWith("{"));
    if (!line) throw new BoatFailure(`boat desktop driver did not answer: ${result.stderr || "empty output"}`);
    let parsed: { ok?: boolean; text?: string; tree?: string; image?: { data?: string; mimeType?: string }; error?: string; schemas?: unknown };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      throw new BoatFailure("boat desktop driver did not answer");
    }
    if (!parsed.ok) throw new BoatFailure(`boat desktop driver did not answer: ${parsed.error ?? "unknown"}`);
    const image = parsed.image?.data
      ? { data: parsed.image.data, mimeType: parsed.image.mimeType || "image/png" }
      : undefined;
    return {
      text: redactBoat(parsed.text ?? ""),
      tree: redactBoat(parsed.tree ?? parsed.text ?? ""),
      image,
      schemas: parseSchemas(parsed.schemas),
    };
  }
}

function mapSandbox(sandbox: Sandbox): BoatSandboxView {
  return {
    id: sandbox.id,
    state: sandbox.state,
    error: sandbox.error ?? null,
    dataExpiredAt: stamp(sandbox.dataExpiredAt),
  };
}

function stamp(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

async function asBoatFailure(error: unknown): Promise<BoatFailure> {
  if (error instanceof BoatFailure) return error;
  if (error instanceof ResponseError) {
    let code = "";
    try {
      const body = (await error.response.clone().json()) as { code?: unknown };
      if (typeof body.code === "string") code = body.code;
    } catch {
      code = "";
    }
    return new BoatFailure(`boat api ${error.response.status}${code ? ` ${code}` : ""}`, { httpStatus: error.response.status, code });
  }
  if (error instanceof Error) return new BoatFailure(error.message);
  return new BoatFailure("boat request failed");
}

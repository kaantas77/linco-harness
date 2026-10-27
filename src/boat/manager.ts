import type { PageSnapshot } from "../tools/browser.js";
import type { ExecResult } from "../tools/computer.js";
import { inspectDestination } from "../browser/navigation-policy.js";
import type { LincoDb } from "../db/database.js";
import { WorkspaceEscapeError } from "../security/workspace.js";
import type { ComputerBinding } from "../types.js";
import { BoatFailure, type BoatClient, type BoatMachineType, type BoatSandboxView, type DesktopObservation } from "./client.js";
import { fitArguments, type DriverSchema } from "./driver-schema.js";
import { REMOTE_PREFIX, REMOTE_WORKSPACE, RETENTION_NOTE, boatFilePath, quoteShell, workspaceRelative } from "./paths.js";
import { redactBoat } from "./redact.js";
import {
  parseVmBrowserResult,
  vmBrowserCallCommand,
  vmBrowserInstallCommand,
  vmBrowserPrepareCommand,
  vmBrowserServeCommand,
  type VmBrowserRequest,
  type VmBrowserResult,
} from "./vm-browser.js";

const USABLE = new Set(["ready", "running", "idle"]);
const STARTING = new Set(["init", "provisioning", "provisioned", "cloning"]);
const STOPPED = new Set(["archived"]);

export interface BoatManagerOptions {
  client: BoatClient;
  db: LincoDb;
  machineType: BoatMachineType;
  ttlSeconds: number;
  idleStopMs: number;
  maxSeconds: number;
  readyTimeoutMs?: number;
  allowLoopback?: boolean;
  lookup?: (host: string) => Promise<Array<{ address: string }>>;
}

export interface ComputerDescription {
  mode: "boat";
  status: ComputerBinding["status"] | "absent";
  sandboxId: string | null;
  machineType: string | null;
  workspacePath: string | null;
  snapshotId: string | null;
  snapshotStatus: string | null;
  retentionNote: string;
  lastError: string | null;
  usage: { seconds: number; dollars: number; sandboxType: string } | null;
}

export class BoatSandboxManager {
  private schemas = new Map<string, DriverSchema>();
  private schemasLoaded = false;
  private readonly readyTimeoutMs: number;
  private readonly seen = new Map<string, number>();

  constructor(private readonly options: BoatManagerOptions) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
  }

  async describe(userId: string): Promise<ComputerDescription> {
    const row = this.options.db.getComputer(userId);
    if (!row) {
      return {
        mode: "boat",
        status: "absent",
        sandboxId: null,
        machineType: null,
        workspacePath: null,
        snapshotId: null,
        snapshotStatus: null,
        retentionNote: RETENTION_NOTE,
        lastError: null,
        usage: null,
      };
    }
    let usage: ComputerDescription["usage"] = null;
    if (row.sandboxId) {
      try {
        usage = await this.options.client.usage(row.sandboxId);
      } catch {
        usage = null;
      }
    }
    return {
      mode: "boat",
      status: row.status,
      sandboxId: row.sandboxId,
      machineType: row.machineType,
      workspacePath: row.workspacePath,
      snapshotId: row.snapshotId,
      snapshotStatus: row.snapshotStatus,
      retentionNote: row.retentionNote,
      lastError: row.lastError,
      usage,
    };
  }

  async ensure(userId: string): Promise<ComputerBinding> {
    const cached = this.seen.get(userId);
    const current = this.options.db.getComputer(userId);
    if (cached && current?.sandboxId && current.status === "ready" && Date.now() - cached < 3_000) return current;
    const begun = this.options.db.beginComputer(userId, this.options.machineType, REMOTE_WORKSPACE, RETENTION_NOTE);
    if (!begun.owner) {
      if (begun.record.sandboxId && begun.record.status !== "creating") return this.refresh(begun.record);
      return this.waitForOwner(userId);
    }
    try {
      const created = await this.options.client.create({
        idempotencyKey: begun.record.idempotencyKey,
        type: this.options.machineType,
        ttlSeconds: this.options.ttlSeconds,
      });
      const ready = await this.waitUntil(created.id, (state) => USABLE.has(state));
      await this.prepareHome(ready.id);
      return this.markReady(userId, ready.id);
    } catch (error) {
      const failure = messageOf(error);
      this.options.db.saveComputer(userId, { status: "error", lastError: failure, touch: false });
      throw new BoatFailure(failure);
    }
  }

  async stop(userId: string): Promise<ComputerBinding> {
    const row = await this.ensure(userId);
    if (!row.sandboxId) throw new BoatFailure("boat sandbox is missing");
    this.seen.delete(userId);
    try {
      await this.options.client.stop(row.sandboxId);
      await this.waitUntil(row.sandboxId, (state) => STOPPED.has(state) || state === "error");
    } catch (error) {
      const failure = messageOf(error);
      this.options.db.saveComputer(userId, { status: "error", lastError: failure, touch: false });
      throw new BoatFailure(failure);
    }
    return this.options.db.saveComputer(userId, { status: "stopped", lastError: null, touch: false });
  }

  async run(userId: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> {
    const row = await this.ensure(userId);
    if (!row.sandboxId) throw new BoatFailure("boat sandbox is missing");
    await this.guardUsage(row);
    const timeoutSeconds = Math.min(60, Math.max(1, Math.ceil(timeoutMs / 1000)));
    try {
      const result = await withSignal(
        this.options.client.command({
          sandboxId: row.sandboxId,
          command,
          cwd: REMOTE_PREFIX,
          timeoutSeconds,
        }),
        signal,
      );
      this.touch(userId);
      return {
        exitCode: result.exitCode,
        stdout: redactBoat(result.stdout),
        stderr: redactBoat(result.stderr || (result.timedOut ? "boat command timed out" : "")),
        timedOut: result.timedOut,
      };
    } catch (error) {
      throw new BoatFailure(messageOf(error));
    }
  }

  async read(userId: string, relativePath: string): Promise<{ text: string; bytes: number }> {
    const row = await this.requireSandbox(userId);
    const file = boatFilePath(relativePath);
    try {
      const text = await this.options.client.readText(row.sandboxId, file);
      this.touch(userId);
      return { text, bytes: Buffer.byteLength(text) };
    } catch (error) {
      if (isMissing(error)) throw new Error(`file not found: ${relativePath}`);
      throw new BoatFailure(messageOf(error));
    }
  }

  async write(userId: string, relativePath: string, content: string): Promise<{ bytes: number }> {
    if (content.length > 1_000_000) throw new Error("content exceeds 1000000 characters");
    const row = await this.requireSandbox(userId);
    const file = boatFilePath(relativePath);
    const parent = file.split("/").slice(0, -1).join("/");
    const made = await this.options.client.command({
      sandboxId: row.sandboxId,
      command: `mkdir -p -- ${quoteShell(`/home/user/${parent}`)}`,
      timeoutSeconds: 15,
    });
    if (made.exitCode !== 0) throw new BoatFailure(made.stderr || "boat directory was not created");
    await this.options.client.writeText(row.sandboxId, file, content);
    this.touch(userId);
    return { bytes: Buffer.byteLength(content) };
  }

  async list(userId: string, relativePath: string): Promise<Array<{ name: string; type: "dir" | "file" }>> {
    const row = await this.requireSandbox(userId);
    const directory = `/home/user/${boatFilePath(relativePath || ".")}`;
    try {
      const entries = await this.options.client.list(row.sandboxId, directory);
      this.touch(userId);
      return entries;
    } catch (error) {
      if (isMissing(error)) throw new Error(`file not found: ${relativePath || "."}`);
      throw new BoatFailure(messageOf(error));
    }
  }

  async remove(userId: string, relativePath: string): Promise<void> {
    const row = await this.requireSandbox(userId);
    const relative = workspaceRelative(relativePath);
    if (!relative) throw new WorkspaceEscapeError(relativePath);
    try {
      await this.options.client.readText(row.sandboxId, boatFilePath(relative));
    } catch (error) {
      if (isMissing(error)) throw new Error(`file not found: ${relativePath}`);
      throw new BoatFailure(messageOf(error));
    }
    const removed = await this.options.client.command({
      sandboxId: row.sandboxId,
      command: `rm -f -- ${quoteShell(`/home/user/${boatFilePath(relative)}`)}`,
      timeoutSeconds: 15,
    });
    if (removed.exitCode !== 0) throw new BoatFailure(removed.stderr || "boat file delete failed");
    this.touch(userId);
  }

  async fetchPage(userId: string, rawUrl: string, signal?: AbortSignal): Promise<PageSnapshot> {
    let current = await inspectDestination(rawUrl, {
      allowLoopback: this.options.allowLoopback === true,
      lookup: this.options.lookup,
    });
    for (let hop = 0; hop < 5; hop += 1) {
      const port = current.url.port || (current.url.protocol === "https:" ? "443" : "80");
      const address = current.addresses[0];
      if (!address) throw new BoatFailure("that address is blocked");
      const command = [
        "curl -sS --max-redirs 0 --max-time 20 -D - --output -",
        `--resolve ${quoteShell(`${current.url.hostname}:${port}:${address}`)}`,
        quoteShell(current.url.toString()),
      ].join(" ");
      const result = await this.run(userId, command, 20_000, signal);
      if (result.timedOut) throw new BoatFailure("boat command timed out");
      if (result.exitCode !== 0) throw new BoatFailure(result.stderr || "boat page fetch failed");
      const parsed = parseCurl(result.stdout);
      if (parsed.status >= 300 && parsed.status < 400 && parsed.location) {
        const next = new URL(parsed.location, current.url).toString();
        current = await inspectDestination(next, {
          allowLoopback: this.options.allowLoopback === true,
          lookup: this.options.lookup,
        });
        continue;
      }
      const text = parsed.body.slice(0, 200_000);
      return { url: current.url.toString(), status: parsed.status || 200, text, truncated: parsed.body.length > text.length };
    }
    throw new BoatFailure("too many redirects");
  }

  schema(name: string): DriverSchema | undefined {
    return this.schemas.get(name);
  }

  schemasSnapshot(): DriverSchema[] {
    return [...this.schemas.values()];
  }

  async desktop(userId: string, taskId: string, tool: string, args: Record<string, unknown>): Promise<DesktopObservation> {
    const row = await this.ensure(userId);
    if (!row.sandboxId) throw new BoatFailure("boat sandbox is missing");
    if (!this.options.db.tryDesktopLock(row.sandboxId, taskId, 90_000)) {
      throw new BoatFailure("desktop is in use by another task");
    }
    try {
      await this.guardUsage(row);
      if (tool !== "tools/list" && !this.schemasLoaded) {
        this.rememberSchemas(await this.options.client.desktop(row.sandboxId, "tools/list", {}));
      }
      let next = args;
      if (tool !== "tools/list") {
        const fitted = fitArguments(this.schemas.get(tool), args);
        if (fitted.missing.length > 0) throw new BoatFailure(`desktop ${tool} is missing ${fitted.missing.join(", ")}`);
        next = fitted.args;
      }
      const observation = await this.options.client.desktop(row.sandboxId, tool, next);
      if (tool === "tools/list") this.rememberSchemas(observation);
      return observation;
    } finally {
      this.options.db.releaseDesktopLock(row.sandboxId, taskId);
      this.touch(userId);
    }
  }

  /** One desktop lock for a short mechanical sequence. The first failed step stops the rest. */
  async desktopSequence(
    userId: string,
    taskId: string,
    steps: Array<{ tool: string; args: Record<string, unknown> }>,
  ): Promise<Array<{ tool: string; ok: boolean; detail: string }>> {
    if (steps.length === 0 || steps.length > 8) throw new BoatFailure("desktop sequence needs 1 to 8 steps");
    const allowed = new Set(["click", "type_text", "press_key", "hotkey", "bring_to_front"]);
    const row = await this.ensure(userId);
    if (!row.sandboxId) throw new BoatFailure("boat sandbox is missing");
    if (!this.options.db.tryDesktopLock(row.sandboxId, taskId, 90_000)) {
      throw new BoatFailure("desktop is in use by another task");
    }
    const results: Array<{ tool: string; ok: boolean; detail: string }> = [];
    try {
      await this.guardUsage(row);
      if (!this.schemasLoaded) this.rememberSchemas(await this.options.client.desktop(row.sandboxId, "tools/list", {}));
      for (const step of steps) {
        if (!allowed.has(step.tool)) {
          results.push({ tool: step.tool, ok: false, detail: "step is not allowed" });
          break;
        }
        try {
          const fitted = fitArguments(this.schemas.get(step.tool), step.args);
          if (fitted.missing.length > 0) throw new BoatFailure(`desktop ${step.tool} is missing ${fitted.missing.join(", ")}`);
          const observation = await this.options.client.desktop(row.sandboxId, step.tool, fitted.args);
          results.push({ tool: step.tool, ok: true, detail: observation.text.slice(0, 180) });
        } catch (error) {
          results.push({ tool: step.tool, ok: false, detail: messageOf(error).slice(0, 180) });
          break;
        }
      }
      return results;
    } finally {
      this.options.db.releaseDesktopLock(row.sandboxId, taskId);
      this.touch(userId);
    }
  }

  async browserAct(userId: string, taskId: string, request: VmBrowserRequest): Promise<VmBrowserResult> {
    if (request.op === "goto" || request.op === "fill" || request.op === "navigate" || request.op === "openRead") {
      await inspectDestination(request.url, { allowLoopback: false, lookup: this.options.lookup });
    }
    if (request.op === "fill") {
      if (!/^[A-Za-z0-9_-]+$/.test(request.name) || request.text.length > 200) throw new BoatFailure("field is not allowed");
    }
    if (request.op === "clickRef" || request.op === "fillRef" || request.op === "selectRef") {
      if (!/^b\d+$/.test(request.ref) || !Number.isInteger(request.snapshotId)) throw new BoatFailure("that snapshot is stale — call browser_snapshot");
    }
    if (request.op === "showFile") workspaceRelative(request.relative);
    const row = await this.ensure(userId);
    if (!row.sandboxId) throw new BoatFailure("boat sandbox is missing");
    if (!this.options.db.tryDesktopLock(row.sandboxId, taskId, 200_000)) {
      throw new BoatFailure("desktop is in use by another task");
    }
    try {
      await this.guardUsage(row);
      const prepared = await this.run(userId, vmBrowserPrepareCommand(), 20_000);
      if (prepared.exitCode !== 0) throw new BoatFailure(prepared.stderr || "vm browser script was not written");
      await this.run(userId, vmBrowserInstallCommand(), 60_000).catch(() => undefined);
      const served = await this.run(userId, vmBrowserServeCommand(), 60_000);
      if (served.exitCode !== 0) throw new BoatFailure(served.stderr || served.stdout || "vm browser did not start");
      const called = await this.run(userId, vmBrowserCallCommand(request), 50_000);
      if (called.exitCode !== 0) throw new BoatFailure(called.stderr || called.stdout || "vm browser call failed");
      return parseVmBrowserResult(called.stdout);
    } catch (error) {
      if (error instanceof BoatFailure) throw error;
      throw new BoatFailure(messageOf(error));
    } finally {
      this.options.db.releaseDesktopLock(row.sandboxId, taskId);
      this.touch(userId);
    }
  }

  async reapIdle(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.options.idleStopMs).toISOString();
    let stopped = 0;
    for (const row of this.options.db.listIdleComputers(cutoff)) {
      if (!row.sandboxId || this.options.db.userHasOpenTask(row.userId)) continue;
      this.seen.delete(row.userId);
      try {
        await this.options.client.stop(row.sandboxId);
        this.options.db.saveComputer(row.userId, { status: "stopped", lastError: null, touch: false });
        stopped += 1;
      } catch (error) {
        this.options.db.saveComputer(row.userId, { status: "error", lastError: messageOf(error), touch: false });
      }
    }
    return stopped;
  }

  private async requireSandbox(userId: string): Promise<ComputerBinding & { sandboxId: string }> {
    const row = await this.ensure(userId);
    if (!row.sandboxId) throw new BoatFailure("boat sandbox is missing");
    return row as ComputerBinding & { sandboxId: string };
  }

  private async refresh(row: ComputerBinding): Promise<ComputerBinding> {
    if (!row.sandboxId) return this.waitForOwner(row.userId);
    let remote: BoatSandboxView;
    try {
      remote = await this.options.client.get(row.sandboxId);
    } catch (error) {
      throw new BoatFailure(messageOf(error));
    }
    if (remote.dataExpiredAt && !USABLE.has(remote.state)) throw new BoatFailure("boat snapshot data has expired");
    if (USABLE.has(remote.state)) return this.markReady(row.userId, remote.id);
    if (STOPPED.has(remote.state)) {
      await this.guardUsage(row);
      try {
        await this.options.client.resume(remote.id);
        const ready = await this.waitUntil(remote.id, (state) => USABLE.has(state));
        await this.prepareHome(ready.id);
        return this.markReady(row.userId, ready.id);
      } catch (error) {
        const failure = messageOf(error);
        this.options.db.saveComputer(row.userId, { status: "error", lastError: failure, touch: false });
        throw new BoatFailure(failure);
      }
    }
    if (STARTING.has(remote.state) || remote.state === "archiving") {
      const ready = await this.waitUntil(remote.id, (state) => USABLE.has(state) || STOPPED.has(state));
      if (STOPPED.has(ready.state)) return this.refresh({ ...row, status: "stopped" });
      return this.markReady(row.userId, ready.id);
    }
    throw new BoatFailure(`boat sandbox is ${remote.state}${remote.error ? `: ${remote.error}` : ""}`);
  }

  private async waitForOwner(userId: string): Promise<ComputerBinding> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      const row = this.options.db.getComputer(userId);
      if (!row) throw new BoatFailure("computer row disappeared");
      if (row.status === "error") throw new BoatFailure(row.lastError ?? "boat sandbox create failed");
      if (row.sandboxId && row.status !== "creating") return this.refresh(row);
      await sleep(500);
    }
    throw new BoatFailure("boat sandbox create did not finish");
  }

  private async waitUntil(sandboxId: string, accept: (state: string) => boolean): Promise<BoatSandboxView> {
    const deadline = Date.now() + this.readyTimeoutMs;
    let latest: BoatSandboxView | undefined;
    while (Date.now() < deadline) {
      latest = await this.options.client.get(sandboxId);
      if (latest.dataExpiredAt && !USABLE.has(latest.state)) throw new BoatFailure("boat snapshot data has expired");
      if (accept(latest.state)) return latest;
      if (latest.state === "error" || latest.state === "cancelled") {
        throw new BoatFailure(`boat sandbox entered ${latest.state}${latest.error ? `: ${latest.error}` : ""}`);
      }
      await sleep(500);
    }
    throw new BoatFailure(`boat sandbox was not ready (${latest?.state ?? "unknown"})`);
  }

  private async prepareHome(sandboxId: string): Promise<void> {
    const made = await this.options.client.command({
      sandboxId,
      command: `mkdir -p -- ${quoteShell(REMOTE_WORKSPACE)}`,
      timeoutSeconds: 15,
    });
    if (made.exitCode !== 0) throw new BoatFailure(made.stderr || "boat workspace was not created");
  }

  private async markReady(userId: string, sandboxId: string): Promise<ComputerBinding> {
    let snapshotId: string | null = null;
    let snapshotStatus: string | null = null;
    try {
      const snapshot = await this.options.client.latestSnapshot(sandboxId);
      snapshotId = snapshot?.id ?? null;
      snapshotStatus = snapshot?.status ?? null;
    } catch {
      snapshotId = null;
    }
    const saved = this.options.db.saveComputer(userId, {
      sandboxId,
      status: "ready",
      snapshotId,
      snapshotStatus,
      lastError: null,
      touch: true,
    });
    this.seen.set(userId, Date.now());
    return saved;
  }

  private async guardUsage(row: ComputerBinding): Promise<void> {
    if (!row.sandboxId) return;
    const usage = await this.options.client.usage(row.sandboxId);
    if (usage.seconds < this.options.maxSeconds) return;
    this.seen.delete(row.userId);
    try {
      await this.options.client.stop(row.sandboxId);
    } catch {
      // The limit still blocks the next command when the stop itself fails.
    }
    this.options.db.saveComputer(row.userId, { status: "stopped", lastError: "boat usage limit reached", touch: false });
    throw new BoatFailure("boat usage limit reached");
  }

  private rememberSchemas(observation: DesktopObservation): void {
    this.schemasLoaded = true;
    for (const schema of observation.schemas ?? []) this.schemas.set(schema.name, schema);
  }

  private touch(userId: string): void {
    const row = this.options.db.getComputer(userId);
    if (!row) return;
    this.options.db.saveComputer(userId, { touch: true });
    this.seen.set(userId, Date.now());
  }
}

function parseCurl(stdout: string): { status: number; location?: string; body: string } {
  if (!stdout.startsWith("HTTP/")) return { status: 200, body: stdout };
  const split = stdout.split(/\r?\n\r?\n/);
  const header = split[0] ?? "";
  const body = split.slice(1).join("\n\n");
  const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(header)?.[1] ?? 0);
  const location = /^location:\s*(.+)$/im.exec(header)?.[1]?.trim();
  return { status, location, body };
}

function isMissing(error: unknown): boolean {
  const text = messageOf(error);
  return /404|not found|ENOENT|no such file/i.test(text);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return redactBoat(error.message);
  return redactBoat(String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new BoatFailure("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new BoatFailure("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

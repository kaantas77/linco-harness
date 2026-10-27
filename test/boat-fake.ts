import { BoatFailure, type BoatClient, type BoatCommandResult, type BoatMachineType, type BoatSandboxView, type DesktopObservation } from "../src/boat/client.js";

interface Box {
  state: string;
  expired: boolean;
  files: Map<string, string>;
  tmp: Map<string, string>;
}

export class FakeBoat implements BoatClient {
  createCalls = 0;
  commands: string[] = [];
  desktopCalls: Array<{ sandboxId: string; tool: string; args: Record<string, unknown> }> = [];
  usageSeconds = 0;
  delayMs = 0;
  desktopDelayMs = 0;
  commandDelayMs = 0;
  private readonly byKey = new Map<string, string>();
  private readonly boxes = new Map<string, Box>();
  private sequence = 0;

  async create(input: { idempotencyKey: string; type: BoatMachineType; ttlSeconds: number }): Promise<BoatSandboxView> {
    this.createCalls += 1;
    if (this.delayMs) await sleep(this.delayMs);
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return this.view(existing);
    this.sequence += 1;
    const id = `sbx_${this.sequence}`;
    this.byKey.set(input.idempotencyKey, id);
    this.boxes.set(id, { state: "ready", expired: false, files: new Map(), tmp: new Map() });
    return this.view(id);
  }

  async get(sandboxId: string): Promise<BoatSandboxView> {
    return this.view(sandboxId);
  }

  async stop(sandboxId: string): Promise<void> {
    const box = this.must(sandboxId);
    box.state = "archived";
    box.tmp.clear();
  }

  async resume(sandboxId: string): Promise<void> {
    const box = this.must(sandboxId);
    if (box.expired) throw new BoatFailure("boat api 409 snapshot_data_expired");
    box.state = "ready";
  }

  async delete(sandboxId: string): Promise<void> {
    this.boxes.delete(sandboxId);
  }

  async command(input: { sandboxId: string; command: string; cwd?: string; timeoutSeconds: number }): Promise<BoatCommandResult> {
    if (this.commandDelayMs) await sleep(this.commandDelayMs);
    this.commands.push(input.command);
    const box = this.must(input.sandboxId);
    if (input.command.startsWith("curl ")) {
      if (input.command.includes("evil.test")) {
        return ok("HTTP/1.1 302 Found\r\nlocation: http://169.254.169.254/latest\r\n\r\n");
      }
      return ok("HTTP/1.1 200 OK\r\n\r\nexample page");
    }
    const printed = /^printf\s+(\S+)\s*>\s*(\S+)\s*$/.exec(input.command.trim());
    if (printed) {
      const target = printed[2] ?? "";
      const content = printed[1] ?? "";
      if (target.startsWith("/tmp/")) box.tmp.set(target, content);
      else box.files.set(place(input.cwd, target), content);
      return ok("");
    }
    const removed = /^rm -f -- '([^']+)'$/.exec(input.command.trim());
    if (removed?.[1]) {
      const relative = removed[1].replace("/home/user/", "");
      box.files.delete(relative);
      return ok("");
    }
    if (input.command.includes("boat_secret")) return ok("boat_secret https://box.on.boat.dev/desk?_token=abc");
    if (input.command.includes("vm-browser.mjs call")) {
      return ok('{"ok":true,"engine":"playwright","op":"goto","title":"Example Domain","url":"https://example.com/","text":"Example Domain"}\n');
    }
    return ok("");
  }

  async readText(sandboxId: string, path: string): Promise<string> {
    const value = this.must(sandboxId).files.get(path);
    if (value === undefined) throw new BoatFailure("boat api 404");
    return value;
  }

  async writeText(sandboxId: string, path: string, content: string): Promise<void> {
    this.must(sandboxId).files.set(path, content);
  }

  async list(sandboxId: string, path: string): Promise<Array<{ name: string; type: "dir" | "file" }>> {
    const prefix = path.replace("/home/user/", "").replace(/\/$/, "");
    const names = new Map<string, "dir" | "file">();
    for (const key of this.must(sandboxId).files.keys()) {
      if (!key.startsWith(`${prefix}/`)) continue;
      const rest = key.slice(prefix.length + 1);
      const [name, ...more] = rest.split("/");
      if (!name) continue;
      names.set(name, more.length > 0 || names.get(name) === "dir" ? "dir" : "file");
    }
    return [...names].map(([name, type]) => ({ name, type }));
  }

  async usage(): Promise<{ seconds: number; dollars: number; sandboxType: string }> {
    return { seconds: this.usageSeconds, dollars: this.usageSeconds / 100_000, sandboxType: "small" };
  }

  async latestSnapshot(sandboxId: string): Promise<{ id: string; status: string } | null> {
    this.must(sandboxId);
    return { id: `snap_${sandboxId}`, status: "completed" };
  }

  failDesktopTool = "";

  async desktop(sandboxId: string, tool: string, args: Record<string, unknown>): Promise<DesktopObservation> {
    this.must(sandboxId);
    this.desktopCalls.push({ sandboxId, tool, args });
    if (this.desktopDelayMs) await sleep(this.desktopDelayMs);
    if (tool === this.failDesktopTool) throw new Error("driver failed");
    if (tool === "get_browser_state") return { text: "title Example Domain", tree: "window Chrome\ntitle Example Domain" };
    if (tool === "get_desktop_state" || tool === "get_window_state") {
      return { text: "window Chrome", tree: "window Chrome", image: { data: "aGk=", mimeType: "image/png" } };
    }
    return { text: "ok", tree: "ok" };
  }

  expire(sandboxId: string): void {
    this.must(sandboxId).expired = true;
  }

  tmp(sandboxId: string, path: string): string | undefined {
    return this.must(sandboxId).tmp.get(path);
  }

  private must(sandboxId: string): Box {
    const box = this.boxes.get(sandboxId);
    if (!box) throw new BoatFailure(`boat api 404`);
    return box;
  }

  private view(sandboxId: string): BoatSandboxView {
    const box = this.must(sandboxId);
    return {
      id: sandboxId,
      state: box.state,
      error: null,
      dataExpiredAt: box.expired ? "2026-11-08T00:00:00.000Z" : null,
    };
  }
}

function ok(stdout: string): BoatCommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

function place(cwd: string | undefined, target: string): string {
  if (target.startsWith("/")) return target.replace("/home/user/", "");
  return `${cwd ?? "linco"}/${target}`.replace(/\/+/g, "/");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

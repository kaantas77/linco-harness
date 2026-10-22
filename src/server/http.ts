import http from "node:http";
import type { Harness } from "../agent/runtime.js";
import { projectMessages } from "../agent/transcript.js";
import { toNemoTrace } from "../observe/nemo.js";
import type { AutomationKind, MemoryKind } from "../types.js";

export class HarnessServer {
  private readonly server: http.Server;
  private boundPort = 0;

  constructor(private readonly harness: Harness) {
    this.server = http.createServer((request, response) => {
      this.dispatch(request, response).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof Error ? error.message : "internal error";
        send(response, status, { error: message });
      });
    });
  }

  get port(): number {
    return this.boundPort;
  }

  listen(port = this.harness.config.port, host = this.harness.config.host): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        const address = this.server.address();
        this.boundPort = address && typeof address !== "string" ? address.port : port;
        resolve(this.boundPort);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async dispatch(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://linco.local");
    const method = request.method ?? "GET";
    const path = url.pathname;
    if (method === "GET" && path === "/health") {
      send(response, 200, {
        ok: true,
        model: this.harness.config.model,
        workers: this.harness.config.workerCount,
        deepseekConfigured: Boolean(this.harness.config.apiKey),
      });
      return;
    }

    const sessionMessages = match(path, "/v1/sessions/:id/messages");
    const session = match(path, "/v1/sessions/:id");
    const taskCancel = match(path, "/v1/tasks/:id/cancel");
    const taskApprove = match(path, "/v1/tasks/:id/approve");
    const taskObserve = match(path, "/v1/tasks/:id/observe");
    const task = match(path, "/v1/tasks/:id");
    const memories = match(path, "/v1/users/:id/memories");
    const memory = match(path, "/v1/memories/:id");
    const automations = match(path, "/v1/users/:id/automations");
    const notifications = match(path, "/v1/users/:id/notifications");
    const notificationRead = match(path, "/v1/notifications/:id/read");
    const webhook = match(path, "/v1/webhooks/:token");

    if (method === "POST" && path === "/v1/users") {
      const body = await readJson(request);
      const name = requiredString(body, "name");
      send(response, 201, this.harness.createUser(name));
      return;
    }
    if (method === "POST" && path === "/v1/sessions") {
      const body = await readJson(request);
      send(response, 201, this.harness.createSession(requiredString(body, "userId")));
      return;
    }
    if (method === "GET" && session && !sessionMessages) {
      const found = this.harness.db.getSession(idOf(session));
      if (!found) throw new HttpError(404, "session not found");
      send(response, 200, {
        session: found,
        messages: projectMessages(this.harness.db.getTranscript(found.id)),
        tasks: this.harness.db.listSessionTasks(found.id),
      });
      return;
    }
    if (method === "POST" && sessionMessages) {
      const body = await readJson(request);
      const waitMs = optionalNumber(body, "waitMs");
      const taskRecord = await this.harness.submit(idOf(sessionMessages), requiredString(body, "text"), {
        waitMs,
        maxAttempts: optionalNumber(body, "maxAttempts"),
      });
      send(response, 202, taskRecord);
      return;
    }
    if (method === "GET" && task && !taskCancel && !taskApprove && !taskObserve) {
      send(response, 200, {
        task: this.requireTask(idOf(task)),
        approvals: this.harness.db.listApprovals(idOf(task)),
        usage: this.harness.db.usageSummary(idOf(task)),
      });
      return;
    }
    if (method === "POST" && taskCancel) {
      send(response, 200, this.harness.cancel(idOf(taskCancel)));
      return;
    }
    if (method === "POST" && taskApprove) {
      const body = await readJson(request);
      const decision = requiredString(body, "decision");
      if (decision !== "approved" && decision !== "denied") throw new HttpError(400, "decision must be approved or denied");
      send(response, 200, this.harness.approve(idOf(taskApprove), requiredString(body, "approvalId"), decision));
      return;
    }
    if (method === "GET" && taskObserve) {
      send(response, 200, toNemoTrace(this.harness.db, idOf(taskObserve)));
      return;
    }
    if (method === "GET" && memories) {
      send(response, 200, { memories: this.harness.db.listMemories(idOf(memories)) });
      return;
    }
    if (method === "POST" && memories) {
      const body = await readJson(request);
      send(response, 201, this.harness.db.createMemory({
        userId: idOf(memories),
        title: requiredString(body, "title"),
        body: requiredString(body, "body"),
        kind: memoryKind(optionalString(body, "kind") ?? "fact"),
      }));
      return;
    }
    if (method === "PATCH" && memory) {
      const body = await readJson(request);
      const kind = optionalString(body, "kind");
      send(response, 200, this.harness.db.updateMemory(idOf(memory), {
        title: optionalString(body, "title"),
        body: optionalString(body, "body"),
        kind: kind ? memoryKind(kind) : undefined,
      }));
      return;
    }
    if (method === "DELETE" && memory) {
      this.harness.db.deleteMemory(idOf(memory));
      send(response, 204, null);
      return;
    }
    if (method === "GET" && path === "/v1/skills") {
      send(response, 200, { skills: this.harness.skills.list() });
      return;
    }
    if (method === "GET" && automations) {
      send(response, 200, { automations: this.harness.db.listAutomations(idOf(automations)) });
      return;
    }
    if (method === "POST" && automations) {
      const body = await readJson(request);
      const kind = automationKind(requiredString(body, "kind"));
      send(response, 201, this.harness.createAutomation({
        userId: idOf(automations),
        kind,
        name: requiredString(body, "name"),
        prompt: requiredString(body, "prompt"),
        schedule: optionalString(body, "schedule"),
        everyMs: optionalNumber(body, "everyMs"),
      }));
      return;
    }
    if (method === "POST" && webhook) {
      const payload = await readJson(request);
      send(response, 202, this.harness.acceptWebhook(tokenOf(webhook), payload));
      return;
    }
    if (method === "GET" && notifications) {
      send(response, 200, { notifications: this.harness.db.listNotifications(idOf(notifications)) });
      return;
    }
    if (method === "POST" && notificationRead) {
      this.harness.db.markNotificationRead(idOf(notificationRead));
      send(response, 204, null);
      return;
    }
    throw new HttpError(404, "not found");
  }

  private requireTask(id: string) {
    const task = this.harness.db.getTask(id);
    if (!task) throw new HttpError(404, "task not found");
    return task;
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function idOf(found: Record<string, string>): string {
  const value = found.id;
  if (!value) throw new HttpError(500, "missing route id");
  return value;
}

function tokenOf(found: Record<string, string>): string {
  const value = found.token;
  if (!value) throw new HttpError(500, "missing route token");
  return value;
}

function match(pathname: string, template: string): Record<string, string> | undefined {
  const names: string[] = [];
  const pattern = template.replace(/:([A-Za-z]+)/g, (_full, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  const found = new RegExp(`^${pattern}$`).exec(pathname);
  if (!found) return undefined;
  const params: Record<string, string> = {};
  names.forEach((name, index) => {
    params[name] = decodeURIComponent(found[index + 1] ?? "");
  });
  return params;
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new HttpError(413, "body too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "expected a JSON object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid JSON");
  }
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} is required`);
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`);
  return value;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, `${key} must be a number`);
  return value;
}

function memoryKind(value: string): MemoryKind {
  if (value === "preference" || value === "fact" || value === "project" || value === "task") return value;
  throw new HttpError(400, "invalid memory kind");
}

function automationKind(value: string): AutomationKind {
  if (value === "cron" || value === "heartbeat" || value === "webhook") return value;
  throw new HttpError(400, "invalid automation kind");
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    response.writeHead(status);
    response.end();
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

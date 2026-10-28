/** Polling client for an existing app. The server also offers `GET /v1/tasks/:id/events`. */

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_children"
  | "needs_inspection"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface LincoTask {
  id: string;
  status: TaskStatus;
  prompt: string;
  resultText: string | null;
  error: string | null;
  sessionId: string;
  userId: string;
}

export interface TaskView {
  task: LincoTask;
  approvals: Array<{ id: string; status: string; toolName: string; reason: string }>;
  usage: { turns: number; inputTokens: number; outputTokens: number; costUsd: number };
  children: Array<{ id: string; status: TaskStatus }>;
  evidence: {
    contract: { kind: string; token?: string; file?: string } | null;
    runs: Array<{ name: string; isError: boolean; run?: { exitCode: number; timedOut: boolean; stdout: string; path?: string; command?: string } }>;
  };
}

const TERMINAL = new Set<TaskStatus>(["succeeded", "failed", "cancelled", "needs_inspection"]);
const PAUSED = new Set<TaskStatus>(["waiting_approval", "waiting_children"]);

export class LincoClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  async createUser(name: string): Promise<{ id: string; token?: string }> {
    return this.request("POST", "/v1/users", { name });
  }

  async createSession(userId: string): Promise<{ id: string }> {
    return this.request("POST", "/v1/sessions", { userId });
  }

  async sendMessage(sessionId: string, text: string, waitMs = 0): Promise<LincoTask> {
    return this.request("POST", `/v1/sessions/${sessionId}/messages`, { text, waitMs });
  }

  /** Server-side map. The response has no Linco user token. */
  async openAppSession(externalUserId: string): Promise<{ userId: string; sessionId: string }> {
    return this.request("POST", "/v1/app/sessions", { externalUserId });
  }

  async sendAppMessage(externalUserId: string, text: string, waitMs = 0): Promise<TaskView> {
    return this.request("POST", "/v1/app/messages", { externalUserId, text, waitMs });
  }

  async appTask(taskId: string): Promise<TaskView> {
    return this.request("GET", `/v1/app/tasks/${taskId}`);
  }

  async approveApp(taskId: string, approvalId: string, decision: "approved" | "denied"): Promise<LincoTask> {
    return this.request("POST", `/v1/app/tasks/${taskId}/approve`, { approvalId, decision });
  }

  async cancelApp(taskId: string): Promise<LincoTask> {
    return this.request("POST", `/v1/app/tasks/${taskId}/cancel`, {});
  }

  async task(taskId: string): Promise<TaskView> {
    return this.request("GET", `/v1/tasks/${taskId}`);
  }

  async evidence(taskId: string): Promise<TaskView> {
    return this.request("GET", `/v1/tasks/${taskId}/evidence`);
  }

  async approve(taskId: string, approvalId: string, decision: "approved" | "denied"): Promise<LincoTask> {
    return this.request("POST", `/v1/tasks/${taskId}/approve`, { approvalId, decision });
  }

  async cancel(taskId: string): Promise<LincoTask> {
    return this.request("POST", `/v1/tasks/${taskId}/cancel`, {});
  }

  async computer(userId: string): Promise<{ mode: string; sandboxId?: string | null; workspacePath?: string | null }> {
    return this.request("GET", `/v1/users/${userId}/computer`);
  }

  /** Poll until the task leaves the queue. Use this from an app that already polls. */
  async wait(taskId: string, timeoutMs = 30_000, intervalMs = 200): Promise<TaskView> {
    const started = Date.now();
    let latest = await this.task(taskId);
    while (!TERMINAL.has(latest.task.status) && !PAUSED.has(latest.task.status) && Date.now() - started < timeoutMs) {
      await sleep(intervalMs);
      latest = await this.task(taskId);
    }
    return latest;
  }

  /**
   * Follows `GET /v1/tasks/:id/events`, or the app route when `app` is set.
   * A dropped connection is opened again. The server repeats the current status.
   */
  async watch(
    taskId: string,
    options: { timeoutMs?: number; signal?: AbortSignal; app?: boolean; onEvent?: (event: { id?: string; status: TaskStatus }) => void } = {},
  ): Promise<TaskView> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const started = Date.now();
    const path = options.app ? `/v1/app/tasks/${taskId}/events` : `/v1/tasks/${taskId}/events`;
    let lastId = "";
    while (Date.now() - started < timeoutMs) {
      if (options.signal?.aborted) throw new Error("watch aborted");
      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      if (lastId) headers["last-event-id"] = lastId;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      options.signal?.addEventListener("abort", onAbort);
      try {
        const response = await fetch(`${this.baseUrl}${path}`, { headers, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`watch failed (${response.status})`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (Date.now() - started < timeoutMs) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const id = /^id:\s*(\S+)/m.exec(block)?.[1];
            const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
            if (id) lastId = id;
            if (!dataLine) continue;
            const event = JSON.parse(dataLine.slice(5).trim()) as { status: TaskStatus };
            options.onEvent?.({ ...(id ? { id } : {}), status: event.status });
            if (options.signal?.aborted) throw new Error("watch aborted");
            if (TERMINAL.has(event.status) || PAUSED.has(event.status)) {
              await reader.cancel().catch(() => undefined);
              return options.app ? this.appTask(taskId) : this.task(taskId);
            }
          }
        }
      } catch (error) {
        if (options.signal?.aborted) throw error instanceof Error ? error : new Error("watch aborted");
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
      }
      await sleep(50);
    }
    return options.app ? this.appTask(taskId) : this.task(taskId);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${method} ${path} failed (${response.status}): ${detail}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    while (!TERMINAL.has(latest.task.status) && latest.task.status !== "waiting_approval" && Date.now() - started < timeoutMs) {
      await sleep(intervalMs);
      latest = await this.task(taskId);
    }
    return latest;
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

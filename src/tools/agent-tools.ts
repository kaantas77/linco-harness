import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { clip } from "../json.js";
import { selectMemories } from "../prompt/layout.js";
import type { MemoryKind, PlanStep } from "../types.js";
import { defineTool } from "./define.js";
import { error, text } from "./files.js";
import type { ToolHost } from "./host.js";

const PLAN_STATUS = Type.Union([Type.Literal("pending"), Type.Literal("doing"), Type.Literal("done")]);
const MEMORY_KIND = Type.Union([
  Type.Literal("preference"),
  Type.Literal("fact"),
  Type.Literal("project"),
  Type.Literal("task"),
]);

export function catalogTools(host: ToolHost): AgentTool[] {
  return [
    defineTool<Record<string, never>>({
      name: "skill_list",
      label: "List skills",
      description: "List skill names. The stable system prompt already includes this catalog.",
      parameters: Type.Object({}),
      executionMode: "parallel",
      execute: async () => text(JSON.stringify(host.skills.list()), { skills: host.skills.list() }),
    }),
    defineTool<{ name: string }>({
      name: "skill_load",
      label: "Load skill",
      description: "Load the full instructions for one skill.",
      parameters: Type.Object({ name: Type.String() }),
      executionMode: "parallel",
      execute: async (_id, params) => {
        const skill = host.skills.load(params.name);
        if (!skill) return error(`unknown skill ${params.name}`);
        return text(`# ${skill.name}\n${skill.body}`, { name: skill.name });
      },
    }),
    defineTool<{ query: string; limit?: number }>({
      name: "memory_search",
      label: "Search memory",
      description: "Search the user's saved memories. Use this when the task depends on a preference or past fact.",
      parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
      executionMode: "parallel",
      execute: async (_id, params) => {
        const matches = selectMemories(host.db.listMemories(host.userId), params.query, params.limit ?? 5);
        return text(JSON.stringify(matches.map(({ title, body, kind }) => ({ title, body, kind }))), { matches });
      },
    }),
    defineTool<{ title: string; body: string; kind?: MemoryKind }>({
      name: "memory_save",
      label: "Save memory",
      description: "Save a durable user fact or preference. The user can edit or delete it later.",
      parameters: Type.Object({
        title: Type.String(),
        body: Type.String(),
        kind: Type.Optional(MEMORY_KIND),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const memory = host.db.createMemory({
          userId: host.userId,
          title: params.title,
          body: params.body,
          kind: (params.kind ?? "fact") as MemoryKind,
        });
        return text(`saved memory ${memory.title}`, { id: memory.id });
      },
    }),
    defineTool<{ steps: PlanStep[] }>({
      name: "plan_write",
      label: "Write plan",
      description: "Replace the checklist for this task.",
      parameters: Type.Object({
        steps: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), status: PLAN_STATUS })),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const steps = params.steps;
        host.db.setPlan(host.taskId, steps);
        return text(JSON.stringify(steps), { steps });
      },
    }),
    defineTool<{ prompt: string }>({
      name: "task_spawn",
      label: "Spawn task",
      description: "Queue a child task on the worker pool. It runs in its own session and the same workspace.",
      parameters: Type.Object({ prompt: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        if (host.parentTaskId) return error("a child task cannot spawn another child");
        if (params.prompt.length > 8_000) return error("prompt exceeds 8000 characters");
        if (host.db.countChildren(host.taskId) >= 8) return error("child task limit reached");
        const session = host.db.createSession(host.userId, host.skills, host.systemPrompt);
        const task = host.db.enqueueTask({
          sessionId: session.id,
          userId: host.userId,
          prompt: params.prompt,
          kind: "child",
          parentId: host.taskId,
          maxAttempts: 1,
        });
        return text(`queued ${task.id}`, { taskId: task.id, status: task.status });
      },
    }),
    defineTool<{ taskId: string; waitMs?: number }>({
      name: "task_wait",
      label: "Wait for task",
      description: "Read a child task. waitMs 0 returns immediately. Do not poll forever; finish the turn if it is still running.",
      parameters: Type.Object({ taskId: Type.String(), waitMs: Type.Optional(Type.Number()) }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const waitMs = Math.min(Math.max(params.waitMs ?? 0, 0), 20_000);
        const started = Date.now();
        for (;;) {
          const task = host.db.getTask(params.taskId);
          if (!task || task.userId !== host.userId || task.parentId !== host.taskId) return error("child task not found");
          if (task.status !== "queued" && task.status !== "running") {
            return text(clip(task.resultText || task.error || task.status, 4_000), { status: task.status, taskId: task.id });
          }
          if (Date.now() - started >= waitMs || host.signal.aborted) {
            return text(task.status, { status: task.status, taskId: task.id });
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
    }),
  ];
}

export function shellTool(host: ToolHost): AgentTool {
  return defineTool<{ command: string; timeoutMs?: number }>({
    name: "shell_exec",
    label: "Shell",
    description:
      "Run a shell command with the workspace as the working directory and HOME. Paths outside the workspace, sudo, and destructive system commands are blocked. rm waits for approval.",
    parameters: Type.Object({
      command: Type.String(),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 30_000, 100), 60_000);
      const result = await host.computer.exec({
        command: params.command,
        cwd: host.workspaceRoot,
        timeoutMs,
        signal: host.signal,
      });
      const body = [`exit ${result.exitCode}${result.timedOut ? " timeout" : ""}`, result.stdout, result.stderr]
        .filter((part) => part.trim())
        .join("\n");
      if (result.exitCode !== 0 || result.timedOut) return error(body || "command failed");
      return text(body || "ok", { exitCode: result.exitCode });
    },
  });
}

export function webTool(host: ToolHost): AgentTool {
  return defineTool<{ url: string }>({
    name: "web_fetch",
    label: "Fetch page",
    description: "Fetch a public http(s) URL and return visible text. This does not click or run page scripts.",
    parameters: Type.Object({ url: Type.String() }),
    executionMode: "parallel",
    execute: async (_id, params) => {
      try {
        const page = await host.browser.fetchPage(params.url, host.signal);
        return text(`status ${page.status}\nurl ${page.url}\n${page.text}`, { ...page });
      } catch (caught) {
        return error(caught instanceof Error ? caught.message : String(caught));
      }
    },
  });
}

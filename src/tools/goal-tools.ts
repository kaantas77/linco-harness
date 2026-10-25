import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  applyEvidence,
  childPromptFor,
  createGoal,
  goalStatusText,
  markDispatched,
  readyToDispatch,
  replan,
  type GoalDraftStep,
} from "../agent/goal.js";
import type { GoalCheck, GoalPlan } from "../types.js";
import { WorkspaceEscapeError } from "../security/workspace.js";
import { defineTool } from "./define.js";
import { error, text } from "./files.js";
import type { ToolHost } from "./host.js";

const CHECK = Type.Union([
  Type.Object({ kind: Type.Literal("file_exists"), path: Type.String() }),
  Type.Object({ kind: Type.Literal("file_contains"), path: Type.String(), text: Type.String() }),
  Type.Object({ kind: Type.Literal("tool_ok"), tool: Type.String() }),
  Type.Object({ kind: Type.Literal("child_succeeded"), text: Type.Optional(Type.String()) }),
]);

const DRAFT = Type.Object({
  id: Type.String(),
  title: Type.String(),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  expectedOutput: Type.String(),
  criteria: Type.Array(
    Type.Object({
      id: Type.String(),
      description: Type.String(),
      required: Type.Optional(Type.Boolean()),
      check: CHECK,
    }),
  ),
});

export function goalTools(host: ToolHost): AgentTool[] {
  return [
    defineTool<{ goal: string; steps: GoalDraftStep[]; replanBudget?: number }>({
      name: "goal_set",
      label: "Set goal",
      description: "Store a goal, step dependencies, expected outputs, and required checks. Skip this for a one-step task.",
      parameters: Type.Object({
        goal: Type.String(),
        steps: Type.Array(DRAFT),
        replanBudget: Type.Optional(Type.Number()),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const existing = currentGoal(host);
        if (existing && existing.steps.some((step) => step.status === "done" || step.status === "doing" || step.status === "failed" || step.childTaskId)) {
          return error("use goal_replan after a step has started");
        }
        try {
          const plan = createGoal(params.goal, params.steps, params.replanBudget ?? 2);
          if (!host.db.setGoal(host.taskId, plan, host.claim)) return error("worker lease is no longer held");
          return text(goalStatusText(plan), { goal: plan.goal, steps: plan.steps.length });
        } catch (caught) {
          return error(caught instanceof Error ? caught.message : String(caught));
        }
      },
    }),
    defineTool<Record<string, never>>({
      name: "goal_status",
      label: "Goal status",
      description: "Read the short goal summary: active steps, unmet dependencies, and criterion status.",
      parameters: Type.Object({}),
      executionMode: "parallel",
      execute: async () => {
        const plan = currentGoal(host);
        if (!plan) return error("no goal is stored");
        return text(goalStatusText(plan), { replans: plan.replans, steps: plan.steps.length });
      },
    }),
    defineTool<Record<string, never>>({
      name: "goal_dispatch",
      label: "Dispatch ready steps",
      description: "Queue ready steps whose dependencies are done. Dependent steps stay queued until then.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        const plan = currentGoal(host);
        if (!plan) return error("no goal is stored");
        const ready = readyToDispatch(plan);
        if (ready.length === 0) {
          if (!host.db.setGoal(host.taskId, plan, host.claim)) return error("worker lease is no longer held");
          return text(JSON.stringify({ spawned: [], held: plan.steps.filter((step) => step.status === "pending").map((step) => step.id) }), {
            spawned: 0,
            held: plan.steps.filter((step) => step.status === "pending").map((step) => step.id),
          });
        }
        if (host.parentTaskId) return error("a child task cannot spawn another child");
        const dispatched = host.db.dispatchOwned(
          host.claim,
          {
            userId: host.userId,
            skills: host.skills,
            systemPrompt: host.systemPrompt,
            prompts: ready.map((step) => childPromptFor(step)),
            goalFor: (tasks) =>
              markDispatched(
                plan,
                tasks.map((task, index) => ({ stepId: ready[index]?.id ?? task.id, taskId: task.id })),
              ),
          },
        );
        if ("error" in dispatched) return error(dispatched.error);
        const bindings = dispatched.tasks.map((task, index) => ({ stepId: ready[index]?.id ?? task.id, taskId: task.id }));
        for (const task of dispatched.tasks) host.parkChild?.(task.id);
        const saved = markDispatched(plan, bindings);
        const held = saved.steps.filter((step) => step.status === "pending").map((step) => step.id);
        return text(JSON.stringify({ spawned: bindings, held }), { spawned: bindings.length, held });
      },
    }),
    defineTool<{ stepId: string }>({
      name: "goal_evidence",
      label: "Check goal evidence",
      description: "Check one step's required evidence. A missing file or failed child stays unverified. Linco does not mark it done.",
      parameters: Type.Object({ stepId: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const plan = currentGoal(host);
        if (!plan) return error("no goal is stored");
        if (!plan.steps.some((step) => step.id === params.stepId)) return error(`unknown step ${params.stepId}`);
        const saved = applyEvidence(plan, params.stepId, {
          workspaceRoot: host.workspaceRoot,
          taskId: host.taskId,
          db: host.db,
          ...(host.files ? { readFile: await fileSnapshot(host, plan, params.stepId) } : {}),
        });
        if (!host.db.setGoal(host.taskId, saved, host.claim)) return error("worker lease is no longer held");
        const step = saved.steps.find((item) => item.id === params.stepId);
        return text(goalStatusText(saved), { stepId: params.stepId, status: step?.status ?? "missing" });
      },
    }),
    defineTool<{ stepId: string; steps: GoalDraftStep[] }>({
      name: "goal_replan",
      label: "Replan remaining work",
      description: "Keep finished steps. Add replacement steps for one failed step, inside the replan budget. The same failure is not replanned twice.",
      parameters: Type.Object({ stepId: Type.String(), steps: Type.Array(DRAFT) }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const plan = currentGoal(host);
        if (!plan) return error("no goal is stored");
        const result = replan(plan, params.stepId, params.steps);
        if (!host.db.setGoal(host.taskId, result.plan, host.claim)) return error("worker lease is no longer held");
        if (result.error) return error(result.error);
        return text(goalStatusText(result.plan), { replans: result.plan.replans });
      },
    }),
  ];
}

function currentGoal(host: ToolHost): GoalPlan | null {
  return host.db.getTask(host.taskId)?.goal ?? null;
}

async function fileSnapshot(host: ToolHost, plan: GoalPlan, stepId: string): Promise<(relativePath: string) => string | null> {
  const step = plan.steps.find((item) => item.id === stepId);
  const found = new Map<string, string | null | Error>();
  const files = host.files;
  if (files && step) {
    for (const criterion of step.criteria) {
      const check = criterion.check;
      if (check.kind !== "file_exists" && check.kind !== "file_contains") continue;
      try {
        found.set(check.path, (await files.read(check.path)).text);
      } catch (caught) {
        if (caught instanceof WorkspaceEscapeError) found.set(check.path, caught);
        else if (caught instanceof Error && caught.message.startsWith("file not found")) found.set(check.path, null);
        else found.set(check.path, caught instanceof Error ? caught : new Error(String(caught)));
      }
    }
  }
  return (relativePath) => {
    const value = found.get(relativePath);
    if (value instanceof Error) throw value;
    return value ?? null;
  };
}

export type { GoalCheck };

import fs from "node:fs";
import type { LincoDb } from "../db/database.js";
import { resolveInside, WorkspaceEscapeError } from "../security/workspace.js";
import type { GoalCheck, GoalCriterion, GoalPlan, GoalStep } from "../types.js";

const MAX_STEPS = 8;
const MAX_CRITERIA = 4;

export interface GoalDraftStep {
  id: string;
  title: string;
  dependsOn?: string[];
  expectedOutput: string;
  criteria: Array<{ id: string; description: string; required?: boolean; check: GoalCheck }>;
}

export function createGoal(goal: string, drafts: GoalDraftStep[], replanBudget = 2): GoalPlan {
  const plan: GoalPlan = {
    version: 1,
    goal: goal.trim(),
    steps: [],
    replanBudget: clampBudget(replanBudget),
    replans: 0,
    replanNotes: [],
  };
  plan.steps = drafts.map((draft) => newStep(draft));
  validateShape(plan);
  return refresh(plan);
}

export function refresh(plan: GoalPlan): GoalPlan {
  const done = new Set(plan.steps.filter((step) => step.status === "done").map((step) => step.id));
  return {
    ...plan,
    steps: plan.steps.map((step) => {
      if (step.status === "done" || step.status === "failed" || step.status === "replaced" || step.status === "doing" || step.status === "blocked") return step;
      const ready = step.dependsOn.every((id) => done.has(id));
      return { ...step, status: ready ? "ready" : "pending" };
    }),
  };
}

export function goalStatusText(plan: GoalPlan): string {
  const lines = [
    `goal: ${clip(plan.goal, 180)}`,
    `replans ${plan.replans}/${plan.replanBudget}`,
  ];
  const note = plan.replanNotes.at(-1);
  if (note) lines.push(`last note: ${clip(note, 180)}`);
  for (const step of plan.steps) {
    const unmet = step.criteria.filter((criterion) => criterion.required && criterion.status !== "verified");
    const deps = step.dependsOn.filter((id) => plan.steps.find((item) => item.id === id)?.status !== "done");
    lines.push(
      [
        `${step.id} ${step.status}`,
        step.childTaskId ? `child ${step.childTaskId}` : "",
        deps.length > 0 ? `waiting ${deps.join(",")}` : "",
        unmet.length > 0 ? `criteria ${unmet.map((criterion) => `${criterion.id}:${criterion.status}`).join(",")}` : "",
        step.failure ? `failure ${clip(step.failure, 80)}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
    );
  }
  return clip(lines.join("\n"), 1_500);
}

export function goalSuccessBlock(plan: GoalPlan | null): string | undefined {
  if (!plan) return undefined;
  const open = plan.steps.filter((step) => step.status !== "done" && step.status !== "replaced");
  if (open.length === 0) return undefined;
  const detail = open
    .map((step) => {
      const unmet = step.criteria
        .filter((criterion) => criterion.required && criterion.status !== "verified")
        .map((criterion) => `${criterion.id}:${criterion.status}`)
        .join(",");
      return `${step.id}:${step.status}${unmet ? `(${unmet})` : ""}`;
    })
    .join(", ");
  return `goal criteria unmet: ${detail}`;
}

export function readyToDispatch(plan: GoalPlan): GoalStep[] {
  const current = refresh(plan);
  return current.steps.filter((step) => step.status === "ready" && !step.childTaskId);
}

export function markDispatched(plan: GoalPlan, bindings: Array<{ stepId: string; taskId: string }>): GoalPlan {
  const ids = new Map(bindings.map((binding) => [binding.stepId, binding.taskId]));
  return refresh({
    ...plan,
    steps: plan.steps.map((step) => {
      const taskId = ids.get(step.id);
      if (!taskId) return step;
      return { ...step, status: "doing", childTaskId: taskId };
    }),
  });
}

export interface EvidenceLookup {
  workspaceRoot: string;
  taskId: string;
  db: LincoDb;
}

export function applyEvidence(plan: GoalPlan, stepId: string, lookup: EvidenceLookup): GoalPlan {
  const next = {
    ...plan,
    steps: plan.steps.map((step) => (step.id === stepId ? evaluateStep(step, lookup) : step)),
  };
  return refresh(next);
}

export function replan(plan: GoalPlan, stepId: string, drafts: GoalDraftStep[]): { plan: GoalPlan; error?: string } {
  const failed = plan.steps.find((step) => step.id === stepId);
  if (!failed) return { plan, error: `unknown step ${stepId}` };
  if (failed.status !== "failed") return { plan, error: `step ${stepId} is ${failed.status}` };
  const key = `${failed.id}:${failed.failure ?? ""}`;
  if (plan.replans >= plan.replanBudget || plan.lastFailureKey === key) {
    const reason =
      plan.lastFailureKey === key
        ? `same failure on ${failed.id} is not replanned again`
        : `replan budget ${plan.replanBudget} is spent`;
    return { plan: blockRemainder(plan, reason), error: reason };
  }
  let additions: GoalStep[];
  try {
    additions = drafts.map((draft) => newStep(draft));
    const replaced = plan.steps.map((step) => (step.id === failed.id ? { ...step, status: "replaced" as const } : step));
    const rebound = rebindUnstarted(replaced, failed.id, additions.map((step) => step.id));
    validateShape({ ...plan, steps: [...rebound, ...additions] });
    const note = `replanned ${failed.id}: ${clip(failed.failure ?? "failed", 120)}`;
    return {
      plan: refresh({
        ...plan,
        steps: [...rebound, ...additions],
        replans: plan.replans + 1,
        lastFailureKey: key,
        replanNotes: [...plan.replanNotes, note].slice(-4),
      }),
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { plan, error: message };
  }
}

export function childPromptFor(step: GoalStep): string {
  return [`GOAL_STEP ${step.id}`, step.title, `Expected: ${step.expectedOutput}`].join("\n");
}

function evaluateStep(step: GoalStep, lookup: EvidenceLookup): GoalStep {
  const criteria = step.criteria.map((criterion) => evaluateCriterion(criterion, step, lookup));
  const required = criteria.filter((criterion) => criterion.required);
  if (required.every((criterion) => criterion.status === "verified")) {
    return { ...step, status: "done", criteria, failure: undefined };
  }
  const child = step.childTaskId ? lookup.db.getTask(step.childTaskId) : undefined;
  if (child && (child.status === "failed" || child.status === "cancelled" || child.status === "needs_inspection")) {
    return { ...step, status: "failed", criteria, failure: child.error ?? child.status };
  }
  if (required.some((criterion) => criterion.status === "blocked")) {
    return { ...step, status: "blocked", criteria, failure: "a required criterion cannot be checked" };
  }
  return { ...step, criteria };
}

function evaluateCriterion(criterion: GoalCriterion, step: GoalStep, lookup: EvidenceLookup): GoalCriterion {
  const check = criterion.check;
  if (check.kind === "file_exists" || check.kind === "file_contains") {
    let file: string;
    try {
      file = resolveInside(lookup.workspaceRoot, check.path);
    } catch (caught) {
      const reason = caught instanceof WorkspaceEscapeError || caught instanceof Error ? caught.message : String(caught);
      return { ...criterion, status: "blocked", evidence: reason };
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return { ...criterion, status: "unverified", evidence: `missing ${check.path}` };
    }
    if (check.kind === "file_exists") return { ...criterion, status: "verified", evidence: `exists ${check.path}` };
    const body = fs.readFileSync(file, "utf8");
    if (!body.includes(check.text)) return { ...criterion, status: "unverified", evidence: `missing text in ${check.path}` };
    return { ...criterion, status: "verified", evidence: `contains text in ${check.path}` };
  }
  if (check.kind === "tool_ok") {
    const traces = toolEvidenceTraces(step, lookup);
    const hit = selectToolEvidence(step, check.tool, traces);
    return hit
      ? { ...criterion, status: "verified", evidence: `${check.tool} trace ${hit.id}`, evidenceTraceId: hit.id }
      : { ...criterion, status: "unverified", evidence: `${check.tool} has no trace for this step`, evidenceTraceId: undefined };
  }
  const childId = step.childTaskId;
  if (!childId) return { ...criterion, status: "pending", evidence: "child is not dispatched" };
  const child = lookup.db.getTask(childId);
  if (!child || child.parentId !== lookup.taskId) return { ...criterion, status: "blocked", evidence: "child is not this task's child" };
  if (child.status === "queued" || child.status === "running" || child.status === "waiting_children" || child.status === "waiting_approval") {
    return { ...criterion, status: "pending", evidence: child.status };
  }
  if (child.status !== "succeeded") return { ...criterion, status: "unverified", evidence: child.error ?? child.status };
  if (check.text && !String(child.resultText ?? "").includes(check.text)) {
    return { ...criterion, status: "unverified", evidence: "child result missed the expected text" };
  }
  return { ...criterion, status: "verified", evidence: `child ${child.id} succeeded` };
}

/** Steps that have not started follow the replacement instead of the failed step. */
export function rebindUnstarted(steps: GoalStep[], failedId: string, replacementIds: string[]): GoalStep[] {
  return steps.map((step) => {
    if (!step.dependsOn.includes(failedId)) return step;
    if (step.childTaskId || (step.status !== "pending" && step.status !== "ready")) return step;
    const dependsOn = [...new Set([...step.dependsOn.filter((id) => id !== failedId), ...replacementIds])];
    return { ...step, dependsOn };
  });
}

export interface ToolEvidenceTrace {
  id: string;
  taskId: string;
  name: string;
  isError: boolean;
  goalStepId?: string;
}

/** A parent tool call counts only when this step is its sole owner. A child call counts only for that child. */
export function selectToolEvidence(step: GoalStep, tool: string, traces: ToolEvidenceTrace[]): ToolEvidenceTrace | undefined {
  const matches = traces.filter((trace) => trace.name === tool && !trace.isError);
  if (step.childTaskId) return matches.find((trace) => trace.taskId === step.childTaskId);
  return matches.find((trace) => trace.goalStepId === step.id);
}

/** Tag a parent trace only when one open step asks for that tool. Shared tools stay unattributed. */
export function attributeParentTool(plan: GoalPlan | null, toolName: string): string | undefined {
  if (!plan) return undefined;
  const owners = plan.steps.filter(
    (step) =>
      !step.childTaskId &&
      step.status !== "done" &&
      step.status !== "replaced" &&
      step.status !== "failed" &&
      step.status !== "blocked" &&
      step.criteria.some((criterion) => criterion.check.kind === "tool_ok" && criterion.check.tool === toolName && criterion.status !== "verified"),
  );
  return owners.length === 1 ? owners[0]!.id : undefined;
}

function toolEvidenceTraces(step: GoalStep, lookup: EvidenceLookup): ToolEvidenceTrace[] {
  const rows = [
    ...lookup.db.listTraces(lookup.taskId),
    ...(step.childTaskId ? lookup.db.listTraces(step.childTaskId) : []),
  ];
  return rows
    .filter((trace) => trace.kind === "tool" && !startedOnly(trace.data))
    .map((trace) => ({
      id: trace.id,
      taskId: trace.taskId,
      name: trace.name,
      isError: traceIsError(trace.data),
      ...(goalStepIdOf(trace.data) ? { goalStepId: goalStepIdOf(trace.data) } : {}),
    }));
}

function startedOnly(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && (data as { phase?: unknown }).phase === "start");
}

function goalStepIdOf(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || !("goalStepId" in data)) return undefined;
  const value = (data as { goalStepId?: unknown }).goalStepId;
  return typeof value === "string" ? value : undefined;
}

function newStep(draft: GoalDraftStep): GoalStep {
  return {
    id: draft.id.trim(),
    title: draft.title.trim(),
    dependsOn: [...(draft.dependsOn ?? [])],
    expectedOutput: draft.expectedOutput.trim(),
    status: "pending",
    criteria: draft.criteria.map((criterion) => ({
      id: criterion.id.trim(),
      description: criterion.description.trim(),
      required: criterion.required !== false,
      check: criterion.check,
      status: "pending" as const,
    })),
  };
}

function validateShape(plan: GoalPlan): void {
  if (!plan.goal) throw new Error("goal is empty");
  if (plan.steps.length === 0 || plan.steps.length > MAX_STEPS) throw new Error("plan needs 1 to 8 steps");
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!step.id || ids.has(step.id)) throw new Error(`duplicate or empty step id ${step.id}`);
    ids.add(step.id);
    if (!step.title || !step.expectedOutput) throw new Error(`step ${step.id} needs a title and expected output`);
    if (step.criteria.length === 0 || step.criteria.length > MAX_CRITERIA) throw new Error(`step ${step.id} needs 1 to 4 criteria`);
    if (!step.criteria.some((criterion) => criterion.required)) throw new Error(`step ${step.id} needs a required criterion`);
    const criterionIds = new Set<string>();
    for (const criterion of step.criteria) {
      if (!criterion.id || criterionIds.has(criterion.id)) throw new Error(`duplicate criterion on ${step.id}`);
      criterionIds.add(criterion.id);
      if (!criterion.description) throw new Error(`criterion ${criterion.id} needs a description`);
    }
  }
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.id || !ids.has(dep)) throw new Error(`step ${step.id} depends on unknown ${dep}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error("plan has a dependency cycle");
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of plan.steps) visit(step.id);
}

function blockRemainder(plan: GoalPlan, reason: string): GoalPlan {
  return {
    ...plan,
    replanNotes: [...plan.replanNotes, reason].slice(-4),
    steps: plan.steps.map((step) =>
      step.status === "done" || step.status === "replaced" ? step : { ...step, status: "blocked", failure: step.failure ?? reason },
    ),
  };
}

function clampBudget(value: number): number {
  if (!Number.isFinite(value)) return 2;
  return Math.min(3, Math.max(0, Math.floor(value)));
}

function traceIsError(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && "isError" in data && (data as { isError?: boolean }).isError);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function sameGoalIdentity(before: GoalPlan, after: GoalPlan): boolean {
  return before.goal === after.goal && before.steps.every((step) => after.steps.some((item) => item.id === step.id));
}

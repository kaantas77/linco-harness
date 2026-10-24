import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyEvidence, attributeParentTool, createGoal, readyToDispatch, replan, type GoalDraftStep } from "../src/agent/goal.js";
import { LincoDb } from "../src/db/database.js";
import { scriptedReply } from "../src/llm/scripted.js";
import { SkillCatalog } from "../src/skills/catalog.js";
import type { GoalPlan } from "../src/types.js";
import { withHarness } from "./helpers.js";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");

function draft(id: string, dependsOn: string[] = [], tool = "fs_write"): GoalDraftStep {
  return {
    id,
    title: id,
    dependsOn,
    expectedOutput: id,
    criteria: [{ id: "c", description: "check", required: true, check: { kind: "tool_ok", tool } }],
  };
}

function failedPlan(): GoalPlan {
  const plan = createGoal("ship", [draft("a", []), draft("b", ["a"]), draft("d", ["b"])]);
  return {
    ...plan,
    steps: plan.steps.map((step) => {
      if (step.id === "a") return { ...step, status: "done" as const };
      if (step.id === "b") return { ...step, status: "failed" as const, failure: "boom" };
      return step;
    }),
  };
}

describe("goal replan dependencies", () => {
  it("rebinds an unstarted dependent onto the replacement and leaves finished work", () => {
    const result = replan(failedPlan(), "b", [draft("c", ["a"])]);
    expect(result.error).toBeUndefined();
    const steps = result.plan.steps;
    expect(steps.find((step) => step.id === "a")?.status).toBe("done");
    expect(steps.find((step) => step.id === "b")?.status).toBe("replaced");
    expect(steps.find((step) => step.id === "d")?.dependsOn).toEqual(["c"]);
    expect(readyToDispatch(result.plan).map((step) => step.id)).toEqual(["c"]);
  });

  it("does not rebind a step that already started", () => {
    const plan = failedPlan();
    const started = {
      ...plan,
      steps: plan.steps.map((step) => (step.id === "d" ? { ...step, status: "doing" as const, childTaskId: "task_child" } : step)),
    };
    const result = replan(started, "b", [draft("c", ["a"])]);
    expect(result.plan.steps.find((step) => step.id === "d")?.dependsOn).toEqual(["b"]);
  });

  it("rejects a replan that would cycle and leaves the old dependencies", () => {
    const before = failedPlan();
    const result = replan(before, "b", [draft("c", ["d"])]);
    expect(result.error).toContain("cycle");
    expect(result.plan.steps.find((step) => step.id === "d")?.dependsOn).toEqual(["b"]);
  });
});

describe("step scoped tool evidence", () => {
  it("does not let two parent steps share one untagged tool call", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-evidence-"));
    const db = new LincoDb(path.join(dir, "linco.sqlite"));
    try {
      const user = db.createUser("Ada", dir);
      const session = db.createSession(user.id, new SkillCatalog(skillsDir), "prompt");
      const task = db.enqueueTask({ sessionId: session.id, userId: user.id, prompt: "parent" });
      const child = db.enqueueTask({ sessionId: session.id, userId: user.id, prompt: "child", parentId: task.id });
      const plan = createGoal("prove", [draft("a"), draft("b")]);
      const at = new Date().toISOString();
      db.addTrace({ taskId: task.id, kind: "tool", name: "fs_write", startedAt: at, data: { isError: false } });
      const lookup = { workspaceRoot: user.workspacePath, taskId: task.id, db };
      const checked = applyEvidence(applyEvidence(plan, "a", lookup), "b", lookup);
      expect(checked.steps.map((step) => step.criteria[0]?.status)).toEqual(["unverified", "unverified"]);
      expect(checked.steps.every((step) => step.criteria[0]?.evidenceTraceId === undefined)).toBe(true);
      expect(attributeParentTool(plan, "fs_write")).toBeUndefined();

      db.addTrace({ taskId: task.id, kind: "tool", name: "fs_write", startedAt: at, data: { isError: false, goalStepId: "a" } });
      const tagged = applyEvidence(applyEvidence(plan, "a", lookup), "b", lookup);
      const stepA = tagged.steps.find((step) => step.id === "a");
      const stepB = tagged.steps.find((step) => step.id === "b");
      expect(stepA?.criteria[0]?.status).toBe("verified");
      expect(stepA?.criteria[0]?.evidenceTraceId).toMatch(/^trace_/);
      expect(stepB?.criteria[0]?.status).toBe("unverified");

      const bound = {
        ...plan,
        steps: plan.steps.map((step) => (step.id === "a" ? { ...step, childTaskId: child.id } : step)),
      };
      db.addTrace({ taskId: child.id, kind: "tool", name: "fs_write", startedAt: at, data: { isError: false } });
      const fromChild = applyEvidence(applyEvidence(bound, "a", lookup), "b", lookup);
      expect(fromChild.steps.find((step) => step.id === "a")?.criteria[0]?.status).toBe("verified");
      expect(fromChild.steps.find((step) => step.id === "b")?.criteria[0]?.status).toBe("unverified");
      expect(fromChild.steps.find((step) => step.id === "a")?.criteria[0]?.evidenceTraceId).toMatch(/^trace_/);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runtime tool attribution", () => {
  it("tags the only open parent step and stores the trace on the criterion", async () => {
    await withHarness(
      async (harness) => {
        const user = harness.createUser("Ada");
        const session = harness.createSession(user.id);
        const task = await harness.submit(session.id, "set the goal, write the file, check evidence", { waitMs: 5_000 });
        const saved = harness.db.getTask(task.id);
        const trace = harness.db.listTraces(task.id).find((item) => item.kind === "tool" && item.name === "fs_write");
        const data = trace?.data && typeof trace.data === "object" ? (trace.data as { goalStepId?: string }) : {};
        expect(task.status).toBe("succeeded");
        expect(data.goalStepId).toBe("a");
        expect(saved?.goal?.steps[0]?.criteria[0]?.evidenceTraceId).toBe(trace?.id);
      },
      {
        workerCount: 1,
        streamFn: scriptedReply((messages) => {
          const results = messages.filter((message) => message.role === "toolResult").length;
          if (results === 0) {
            return {
              calls: [
                {
                  name: "goal_set",
                  arguments: {
                    goal: "write",
                    steps: [draft("a")],
                  },
                },
              ],
            };
          }
          if (results === 1) return { calls: [{ name: "fs_write", arguments: { path: "note.txt", content: "pear" } }] };
          if (results === 2) return { calls: [{ name: "goal_evidence", arguments: { stepId: "a" } }] };
          return { text: "done" };
        }),
      },
    );
  });

  it("leaves a shared parent tool call untagged so neither step is verified", async () => {
    await withHarness(
      async (harness) => {
        const user = harness.createUser("Ada");
        const session = harness.createSession(user.id);
        const task = await harness.submit(session.id, "two steps, one write", { waitMs: 5_000 });
        const saved = harness.db.getTask(task.id);
        const trace = harness.db.listTraces(task.id).find((item) => item.kind === "tool" && item.name === "fs_write");
        const data = trace?.data && typeof trace.data === "object" ? (trace.data as { goalStepId?: string }) : {};
        expect(task.status).toBe("failed");
        expect(data.goalStepId).toBeUndefined();
        expect(saved?.goal?.steps.map((step) => step.criteria[0]?.status)).toEqual(["unverified", "unverified"]);
      },
      {
        workerCount: 1,
        streamFn: scriptedReply((messages) => {
          const results = messages.filter((message) => message.role === "toolResult").length;
          if (results === 0) return { calls: [{ name: "goal_set", arguments: { goal: "write", steps: [draft("a"), draft("b")] } }] };
          if (results === 1) return { calls: [{ name: "fs_write", arguments: { path: "note.txt", content: "pear" } }] };
          if (results === 2) return { calls: [{ name: "goal_evidence", arguments: { stepId: "a" } }] };
          if (results === 3) return { calls: [{ name: "goal_evidence", arguments: { stepId: "b" } }] };
          return { text: "done" };
        }),
      },
    );
  });
});

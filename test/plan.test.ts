import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createGoal } from "../src/agent/goal.js";
import { renderPlanningMarkdown, runPlanningBench } from "../src/bench/planning.js";
import { buildStablePrompt } from "../src/prompt/layout.js";
import { toolsForPrompt, withJevToolset, withPlanToolset } from "../src/tools/toolset.js";
import type { ToolHost } from "../src/tools/host.js";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");
const reports = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../reports");

describe("goal planning", () => {
  it("keeps v3 tools and appends goal tools only on the v4 prompt", () => {
    const v1 = buildStablePrompt([{ name: "file-ops", description: "Edit files" }]);
    const v3 = withJevToolset(v1);
    const v4 = withPlanToolset(v1);
    expect(v4.startsWith(`${v3}\n`)).toBe(true);
    expect(v1).toBe(buildStablePrompt([{ name: "file-ops", description: "Edit files" }]));
    const host = {} as ToolHost;
    const v3Names = toolsForPrompt(host, v3).map((tool) => tool.name);
    const v4Names = toolsForPrompt(host, v4).map((tool) => tool.name);
    expect(v4Names.slice(0, v3Names.length)).toEqual(v3Names);
    expect(v3Names).not.toContain("goal_set");
    expect(v4Names.slice(v3Names.length)).toEqual(["goal_set", "goal_status", "goal_dispatch", "goal_evidence", "goal_replan"]);
  });

  it("rejects a dependency cycle and a step with no required check", () => {
    expect(() =>
      createGoal("Loop", [
        { id: "a", title: "A", dependsOn: ["b"], expectedOutput: "a", criteria: [required("a")] },
        { id: "b", title: "B", dependsOn: ["a"], expectedOutput: "b", criteria: [required("b")] },
      ]),
    ).toThrow(/cycle/);
    expect(() =>
      createGoal("Loose", [
        {
          id: "a",
          title: "A",
          expectedOutput: "a",
          criteria: [{ id: "c", description: "note", required: false, check: { kind: "file_exists", path: "a.txt" } }],
        },
      ]),
    ).toThrow(/required/);
  });

  it("runs dependent and parallel plans, refuses missing evidence, and keeps the plan across cancel", async () => {
    const report = await runPlanningBench(skillsDir);
    fs.mkdirSync(reports, { recursive: true });
    fs.writeFileSync(path.join(reports, "planning.json"), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(reports, "planning.md"), renderPlanningMarkdown(report));
    const failed = report.scenarios.filter((scenario) => !scenario.ok);
    expect(failed.map((scenario) => `${scenario.id}: ${scenario.detail}`)).toEqual([]);
    const noteOff = report.scenarios.find((scenario) => scenario.id === "compare-note-off");
    const noteOn = report.scenarios.find((scenario) => scenario.id === "compare-note-on");
    const claimOff = report.scenarios.find((scenario) => scenario.id === "compare-claim-off");
    const claimOn = report.scenarios.find((scenario) => scenario.id === "compare-claim-on");
    expect(noteOff?.status).toBe("succeeded");
    expect(noteOn?.status).toBe("succeeded");
    expect((noteOn?.turns ?? 0) > (noteOff?.turns ?? 0)).toBe(true);
    expect(claimOff?.status).toBe("succeeded");
    expect(claimOn?.status).toBe("failed");
    expect(report.performanceClaim).toBe("none");
  }, 30_000);
});

function required(id: string) {
  return { id, description: "file", required: true, check: { kind: "file_exists" as const, path: `${id}.txt` } };
}

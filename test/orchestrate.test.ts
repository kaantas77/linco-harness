import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderOrchestrationMarkdown, runOrchestrationBench } from "../src/bench/orchestration.js";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");
const reports = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../reports");

describe("subagent orchestration", () => {
  it("parks the parent, resumes once, and records the scripted scenarios", async () => {
    const report = await runOrchestrationBench(skillsDir);
    fs.mkdirSync(reports, { recursive: true });
    fs.writeFileSync(path.join(reports, "orchestration.json"), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(reports, "orchestration.md"), renderOrchestrationMarkdown(report));
    const failed = report.scenarios.filter((scenario) => !scenario.ok);
    expect(failed.map((scenario) => `${scenario.id}: ${scenario.detail}`)).toEqual([]);
    const parallel = report.scenarios.find((scenario) => scenario.id === "parallel");
    const sequential = report.scenarios.find((scenario) => scenario.id === "sequential");
    expect(parallel?.overlapped).toBe(true);
    expect(sequential?.overlapped).toBe(false);
    expect(report.performanceClaim).toBe("none");
    expect(report.notes.some((note) => note.includes("not DeepSeek"))).toBe(true);
  }, 30_000);
});

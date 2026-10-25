import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { recoveryDecision } from "../src/agent/lease.js";
import { renderDurableMarkdown, runDurableBench } from "../src/bench/durable.js";
import { Harness } from "../src/agent/runtime.js";
import { loadConfig } from "../src/config.js";
import { createGoal } from "../src/agent/goal.js";
import { SCRIPT_MODEL, scriptedReply } from "../src/llm/scripted.js";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");
const reports = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../reports");

describe("lease decisions", () => {
  it("requeues a read and inspects a write or an open tool", () => {
    expect(recoveryDecision([])).toBe("requeue");
    expect(recoveryDecision([{ kind: "tool", name: "fs_read", data: { phase: "end", toolCallId: "a" } }])).toBe("requeue");
    expect(recoveryDecision([{ kind: "tool", name: "fs_write", data: { phase: "end", toolCallId: "a" } }])).toBe("inspect");
    expect(
      recoveryDecision([
        { kind: "tool", name: "fs_read", data: { phase: "start", toolCallId: "a" } },
        { kind: "tool", name: "fs_read", data: { phase: "end", toolCallId: "a" } },
      ]),
    ).toBe("requeue");
    expect(recoveryDecision([{ kind: "tool", name: "fs_read", data: { phase: "start", toolCallId: "a" } }])).toBe("inspect");
  });
});

describe("preserved states", () => {
  it("keeps a cancelled task, an approval, and a goal across a sweep", async () => {
    const dataDir = fs.mkdtempSync(path.join(path.resolve("/tmp"), "linco-state-"));
    const harness = new Harness({
      config: loadConfig({ dataDir, skillsDir, workerCount: 0, schedulerIntervalMs: 60_000, port: 0, leaseMs: 200 }),
      model: SCRIPT_MODEL,
      streamFn: scriptedReply(() => ({ text: "should not run" })),
    });
    try {
      const user = harness.createUser("Ada");
      const session = harness.createSession(user.id);
      const cancelled = harness.db.enqueueTask({ sessionId: session.id, userId: user.id, prompt: "cancel me" });
      harness.cancel(cancelled.id);
      const approvalUser = harness.createUser("Bea");
      const approvalSession = harness.createSession(approvalUser.id);
      const paused = harness.db.enqueueTask({ sessionId: approvalSession.id, userId: approvalUser.id, prompt: "pause" });
      const claimed = harness.db.claimTask("setup", 200);
      expect(claimed?.id).toBe(paused.id);
      expect(harness.db.markPaused(paused.id, undefined, { taskId: paused.id, fence: claimed?.fence ?? 0, workerId: "setup" })).toBe(true);
      const goalUser = harness.createUser("Cam");
      const goalSession = harness.createSession(goalUser.id);
      const planned = harness.db.enqueueTask({ sessionId: goalSession.id, userId: goalUser.id, prompt: "plan" });
      const running = harness.db.claimTask("setup", 200);
      expect(running?.id).toBe(planned.id);
      const goal = createGoal("keep", [
        {
          id: "a",
          title: "A",
          expectedOutput: "a",
          criteria: [{ id: "c", description: "file", check: { kind: "file_exists", path: "a.txt" } }],
        },
      ]);
      harness.db.setGoal(planned.id, goal);
      harness.db.settleExpired(planned.id, running?.fence ?? 0, "requeue", new Date(Date.now() + 60_000).toISOString());
      harness.start();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(harness.db.getTask(cancelled.id)?.status).toBe("cancelled");
      expect(harness.db.getTask(paused.id)?.status).toBe("waiting_approval");
      const kept = harness.db.getTask(planned.id);
      expect(kept?.status).toBe("queued");
      expect(kept?.goal?.goal).toBe("keep");
      expect(kept?.checkpoint).toBeNull();
    } finally {
      await harness.stop();
    }
  });
});

describe("two processes", () => {
  it("shares one queue, fences stale writes, and recovers a crashed child", async () => {
    const report = await runDurableBench(skillsDir);
    fs.mkdirSync(reports, { recursive: true });
    fs.writeFileSync(path.join(reports, "durable.json"), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(reports, "durable.md"), renderDurableMarkdown(report));
    const failed = report.cases.filter((row) => !row.ok).map((row) => `${row.id}: ${row.detail}`);
    expect(failed).toEqual([]);
    expect(report.performanceClaim).toBe("none");
    expect(report.cases.every((row) => row.lostTranscripts === 0)).toBe(true);
    expect(report.cases.find((row) => row.id === "write-hold")?.doubleRuns).toBe(0);
    expect(report.cases.find((row) => row.id === "parent-child")?.parentChildRate).toBe(1);
  }, 40_000);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { blocksPreserved, continuityHeld, readContinuity } from "../src/bench/continuity.js";
import { cacheHitRatio, cacheMissTokens, compareCache, sumCalls, type CallUsage } from "../src/bench/metrics.js";
import { pendingLiveReport, renderBenchMarkdown } from "../src/bench/report.js";
import { liveScenarios } from "../src/bench/scenarios.js";
import { redactSecrets } from "../src/bench/types.js";
import { withHarness } from "./helpers.js";

const call = (cacheReadTokens: number, inputTokens = 10): CallUsage => ({
  inputTokens,
  outputTokens: 4,
  cacheReadTokens,
  cacheWriteTokens: 0,
  costUsd: 0.0001,
});

describe("benchmark metrics", () => {
  it("compares the first two calls and keeps cache misses out of the hit count", () => {
    const calls = [call(0, 80), call(70, 12)];
    const compared = compareCache(calls);
    expect(compared.firstCallCacheRead).toBe(0);
    expect(compared.secondCallCacheRead).toBe(70);
    expect(compared.secondCallHit).toBe(true);
    expect(compareCache([call(0)]).secondCallHit).toBeNull();
    expect(cacheMissTokens(calls[1]!)).toBe(12);
    const total = sumCalls(calls);
    expect(total.inputTokens).toBe(92);
    expect(total.cacheReadTokens).toBe(70);
    expect(cacheHitRatio(total)).toBeCloseTo(70 / 162);
  });

  it("does not treat a missing key as a finished live run", () => {
    const report = pendingLiveReport("deepseek-flash");
    const markdown = renderBenchMarkdown(report);
    expect(report.liveExecuted).toBe(false);
    expect(report.performanceClaim).toBe("none");
    expect(report.results).toEqual([]);
    expect(markdown).toContain("Live verification is pending");
    expect(markdown).toContain("Performance claim: none");
  });

  it("redacts key-shaped text", () => {
    expect(redactSecrets("failed for sk-abcDEF123")).toBe("failed for sk-[redacted]");
  });

  it("grades the live file scenarios on trimmed workspace contents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-grade-"));
    const file = liveScenarios.find((scenario) => scenario.id === "file-write");
    const multi = liveScenarios.find((scenario) => scenario.id === "multi-step");
    const code = liveScenarios.find((scenario) => scenario.id === "code-run");
    const session = liveScenarios.find((scenario) => scenario.id === "session-continue");
    fs.writeFileSync(path.join(root, "hello.txt"), "hello\n");
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data/items.txt"), "alpha\nbeta\n");
    fs.writeFileSync(path.join(root, "data/count.txt"), "2\n");
    fs.writeFileSync(path.join(root, "result.txt"), "2+2=4\n");
    fs.writeFileSync(path.join(root, "turn.txt"), "one\n");
    fs.writeFileSync(path.join(root, "turn-2.txt"), "two\n");
    expect(file?.grade(root)).toBeUndefined();
    expect(multi?.grade(root)).toBeUndefined();
    expect(code?.grade(root)).toBeUndefined();
    expect(session?.grade(root)).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps the system prompt, tool order, and reasoning block across a second turn", async () => {
    await withHarness(
      async (harness) => {
        const user = harness.createUser("bench");
        const session = harness.createSession(user.id);
        const first = await harness.submit(session.id, "Write the first note", { waitMs: 5_000 });
        expect(first.status).toBe("succeeded");
        const before = readContinuity(harness.db.getTranscript(session.id));
        const second = await harness.submit(session.id, "Write the second note", { waitMs: 5_000 });
        expect(second.status).toBe("succeeded");
        const after = readContinuity(harness.db.getTranscript(session.id));
        const held = continuityHeld(before, after);
        expect(before.systemPrompt).toBe(session.systemPrompt);
        expect(held.systemPromptStable).toBe(true);
        expect(before.toolNames.length).toBeGreaterThan(0);
        expect(held.toolOrderStable).toBe(true);
        expect(before.thinking).toEqual(["reasoning_content:plan-alpha"]);
        expect(held.reasoningPreserved).toBe(true);
        expect(blocksPreserved(before.thinking, [])).toBe(false);
      },
      {
        steps: [
          { calls: [{ name: "fs_write", arguments: { path: "first.txt", content: "one" } }] },
          { text: "wrote first", thinking: "plan-alpha" },
          { text: "wrote second" },
        ],
      },
    );
  });
});

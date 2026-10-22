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

const call = (cacheReadTokens: number, inputTokens = 10, userTurn = 0): CallUsage => ({
  inputTokens,
  outputTokens: 4,
  cacheReadTokens,
  cacheWriteTokens: 0,
  costUsd: 0.0001,
  userTurn,
});

describe("benchmark metrics", () => {
  it("separates the second model call from the second user turn", () => {
    const calls = [call(0, 80, 0), call(70, 12, 0), call(90, 15, 1)];
    const compared = compareCache(calls);
    expect(compared.firstCallCacheRead).toBe(0);
    expect(compared.secondCallCacheRead).toBe(70);
    expect(compared.secondCallHit).toBe(true);
    expect(compared.secondUserTurnCacheRead).toBe(90);
    expect(compared.secondUserTurnHit).toBe(true);
    expect(compareCache([call(0)]).secondCallHit).toBeNull();
    expect(compareCache([call(0, 80, 0), call(70, 12, 0)]).secondUserTurnCacheRead).toBeNull();
    expect(cacheMissTokens(calls[1]!)).toBe(12);
    const total = sumCalls(calls);
    expect(total.inputTokens).toBe(107);
    expect(total.cacheReadTokens).toBe(160);
    expect(cacheHitRatio(total)).toBeCloseTo(160 / (107 + 160));
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

  it("grades files and required tool calls, and rejects a count written without a read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-grade-"));
    const byId = (id: string) => liveScenarios.find((scenario) => scenario.id === id);
    const file = byId("file-write");
    const multi = byId("multi-step");
    const code = byId("code-run");
    const session = byId("session-continue");
    const inbox = byId("inbox-pick");
    const edit = byId("edit-port");
    fs.writeFileSync(path.join(root, "hello.txt"), "hello\n");
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data/items.txt"), "alpha\nbeta\n");
    fs.writeFileSync(path.join(root, "data/count.txt"), "2\n");
    fs.writeFileSync(path.join(root, "result.txt"), "2+2=4\n");
    fs.writeFileSync(path.join(root, "turn.txt"), "one\n");
    fs.writeFileSync(path.join(root, "turn-2.txt"), "two\n");
    fs.writeFileSync(path.join(root, "picked.txt"), "TODO: ship the report\n");
    fs.writeFileSync(path.join(root, "config.txt"), "port=9090\nname=linco\n");
    const tools = [
      { name: "fs_write", arguments: { path: "turn.txt", content: "one" } },
      { name: "fs_write", arguments: { path: "turn-2.txt", content: "two" } },
      { name: "fs_write", arguments: { path: "hello.txt", content: "hello" } },
      { name: "fs_write", arguments: { path: "data/items.txt", content: "alpha\nbeta" } },
      { name: "fs_read", arguments: { path: "data/items.txt" } },
      { name: "fs_write", arguments: { path: "data/count.txt", content: "2" } },
      { name: "code_run", arguments: { source: 'await tools.fs_write({ path: "result.txt", content: "2+2=4" })' } },
      { name: "fs_read", arguments: { path: "inbox.txt" } },
      { name: "fs_write", arguments: { path: "picked.txt", content: "TODO: ship the report" } },
      { name: "fs_edit", arguments: { path: "config.txt", old: "port=8080", new: "port=9090" } },
    ];
    expect(file?.grade({ workspace: root, tools })).toBeUndefined();
    expect(multi?.grade({ workspace: root, tools })).toBeUndefined();
    expect(code?.grade({ workspace: root, tools })).toBeUndefined();
    expect(session?.grade({ workspace: root, tools })).toBeUndefined();
    expect(inbox?.grade({ workspace: root, tools })).toBeUndefined();
    expect(edit?.grade({ workspace: root, tools })).toBeUndefined();
    const skippedRead = tools.filter((tool) => !(tool.name === "fs_read" && tool.arguments.path === "data/items.txt"));
    expect(multi?.grade({ workspace: root, tools: skippedRead })).toBe("fs_read of data/items.txt did not happen between the two writes");
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

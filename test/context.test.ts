import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { balancedSchedule } from "../src/bench/context-live.js";
import { renderContextMarkdown, runContextOffline } from "../src/bench/context.js";
import { zeroUsage } from "../src/llm/scripted.js";
import { planContext } from "../src/prompt/compact.js";

const reports = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../reports");
const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");

function assistant(content: AgentMessage extends infer _T ? Extract<AgentMessage, { role: "assistant" }>["content"] : never, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "deepseek",
    model: "linco-script",
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp,
  };
}

function toolResult(id: string, text: string, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "fs_read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

describe("request context", () => {
  it("keeps the system message, the first instruction, reasoning, and tool pairs", () => {
    const system = { role: "system" as const, content: "STABLE", timestamp: 0 };
    const first = { role: "user" as const, content: "First instruction: keep this", timestamp: 1 };
    const call = assistant([{ type: "toolCall", id: "c1", name: "fs_read", arguments: {} }], 2);
    const full = "FULL-OUTPUT" + "y".repeat(2_000);
    const oldResult = toolResult("c1", full, 3);
    const reasoned = assistant([{ type: "thinking", thinking: "keep-reason" }, { type: "text", text: "still here" }], 4);
    const later = toolResult("c2", "latest", 6);
    const messages: AgentMessage[] = [
      system,
      first,
      { role: "user", content: "MIDDLE-ONLY " + "m".repeat(400), timestamp: 7 },
      { role: "user", content: "middle two", timestamp: 8 },
      { role: "user", content: "middle three", timestamp: 9 },
      call,
      oldResult,
      assistant([{ type: "toolCall", id: "c2", name: "fs_read", arguments: {} }], 5),
      later,
      reasoned,
    ];
    const plan = planContext(messages, { maxChars: 500, keepHead: 1, keepTail: 4 });
    expect(plan.compacted).toBe(true);
    expect(plan.messages[0]).toBe(system);
    expect(plan.messages.some((message) => message.role === "user" && message.content === first.content)).toBe(true);
    expect(plan.messages).toContain(reasoned);
    expect(JSON.stringify(plan.messages)).toContain("[linco-compaction]");
    expect(JSON.stringify(plan.messages)).toContain("Earlier turns were compacted so the request stays inside budget.");
    const ids = new Set<string>();
    for (const message of plan.messages) {
      if (message.role === "assistant") {
        for (const block of message.content) if (block.type === "toolCall") ids.add(block.id);
      }
    }
    for (const message of plan.messages) {
      if (message.role === "toolResult") expect(ids.has(message.toolCallId)).toBe(true);
    }
    expect(oldResult.content[0]).toMatchObject({ text: full });
    expect(plan.beforeChars).toBeGreaterThan(plan.afterChars);
    expect(plan.beforeTokens).toBeGreaterThan(0);
  });

  it("does not compact a short transcript when the model window is passed", () => {
    const system = { role: "system" as const, content: "STABLE", timestamp: 0 };
    const messages: AgentMessage[] = [system, { role: "user", content: "short", timestamp: 1 }];
    const plan = planContext(messages, { maxChars: 180_000, contextWindow: 128_000 });
    expect(plan.compacted).toBe(false);
    expect(plan.messages).toBe(messages);
  });

  it("compacts from the token ceiling only when that ceiling is the tighter guard", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "STABLE", timestamp: 0 },
      ...Array.from({ length: 12 }, (_, index) => ({ role: "user" as const, content: `turn ${index} ${"x".repeat(40)}`, timestamp: index + 1 })),
    ];
    const plan = planContext(messages, { maxChars: 1_000_000, contextWindow: 10 });
    expect(plan.compacted).toBe(true);
  });
});

describe("balanced live order", () => {
  it("reverses scenario order and swaps the first mode on odd repeats", () => {
    const slots = balancedSchedule(["file-op", "goal-evidence"], 2);
    expect(slots.map((slot) => `${slot.repeat}:${slot.scenarioId}:${slot.mode}`)).toEqual([
      "0:file-op:on",
      "0:file-op:off",
      "0:goal-evidence:on",
      "0:goal-evidence:off",
      "1:goal-evidence:off",
      "1:goal-evidence:on",
      "1:file-op:off",
      "1:file-op:on",
    ]);
  });
});

describe("offline context report", () => {
  it("keeps the record when the request is compacted and writes no live numbers", async () => {
    const report = await runContextOffline(skillsDir);
    expect(report.performanceClaim).toBe("none");
    expect(report.liveExecuted).toBe(false);
    expect(report.scenarios.every((row) => row.ok && row.recordKeepsCritical)).toBe(true);
    const longOn = report.scenarios.find((row) => row.id === "long-on");
    const longOff = report.scenarios.find((row) => row.id === "long-off");
    const shortOn = report.scenarios.find((row) => row.id === "short-on");
    expect(longOn?.compacted).toBe(true);
    expect(longOn?.beforeChars).toBeGreaterThan(longOn?.afterChars ?? 0);
    expect(longOff?.compacted).toBe(false);
    expect(shortOn?.compacted).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/sk-/);
    fs.mkdirSync(reports, { recursive: true });
    fs.writeFileSync(path.join(reports, "context.json"), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(reports, "context.md"), renderContextMarkdown(report));
  });
});

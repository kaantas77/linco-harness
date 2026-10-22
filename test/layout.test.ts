import { describe, expect, it } from "vitest";
import { buildStablePrompt, composeUserMessage, selectMemories } from "../src/prompt/layout.js";
import { compactForRequest } from "../src/prompt/compact.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

describe("prompt layout", () => {
  it("keeps user data out of the stable system prompt", () => {
    const stable = buildStablePrompt([
      { name: "web-research", description: "Read pages" },
      { name: "file-ops", description: "Edit files" },
    ]);
    const again = buildStablePrompt([
      { name: "file-ops", description: "Edit files" },
      { name: "web-research", description: "Read pages" },
    ]);
    expect(stable).toBe(again);
    expect(stable.indexOf("- file-ops:")).toBeLessThan(stable.indexOf("- web-research:"));
    expect(stable).not.toContain("/tmp/workspace");
    expect(stable).not.toContain("prefers vim");

    const user = composeUserMessage("Update the editor config", {
      workspace: "/tmp/workspace",
      now: "2026-10-22T04:00:00.000Z",
      memories: [{ title: "Editor", body: "prefers vim" }],
    });
    expect(user).toContain("prefers vim");
    expect(user).toContain("/tmp/workspace");
    expect(user.endsWith("</linco-context>")).toBe(true);
  });

  it("selects only memories that share a word with the task", () => {
    const memories = [
      { title: "Editor", body: "prefers vim" },
      { title: "City", body: "lives in Istanbul" },
    ];
    expect(selectMemories(memories, "Change the editor theme").map((memory) => memory.title)).toEqual(["Editor"]);
    expect(selectMemories(memories, "Hello")).toEqual([]);
  });

  it("compacts the middle and keeps the system message byte for byte", () => {
    const system = { role: "system" as const, content: "STABLE", timestamp: 0 };
    const messages: AgentMessage[] = [
      system,
      ...Array.from({ length: 20 }, (_, index) => ({
        role: "user" as const,
        content: `turn ${index} ${"x".repeat(80)}`,
        timestamp: index + 1,
      })),
    ];
    const compacted = compactForRequest(messages, { maxChars: 400, keepHead: 1, keepTail: 2 });
    expect(compacted[0]).toBe(system);
    expect(compacted.length).toBeLessThan(messages.length);
    expect(JSON.stringify(compacted)).toContain("linco-compaction");
    expect(compactForRequest([system], { maxChars: 10 })).toEqual([system]);
  });
});

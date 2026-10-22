import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface Continuity {
  systemPrompt: string;
  toolNames: string[];
  thinking: string[];
}

export function readContinuity(messages: AgentMessage[]): Continuity {
  return {
    systemPrompt: leadingSystemText(messages),
    toolNames: replayToolNames(messages),
    thinking: thinkingBlocks(messages),
  };
}

export function leadingSystemText(messages: AgentMessage[]): string {
  const first = messages[0];
  if (!first || first.role !== "system") return "";
  return typeof first.content === "string" ? first.content : "";
}

/** Replay tool additions and removals in transcript order. The result is the model-visible tool order. */
export function replayToolNames(messages: AgentMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) {
      if (!names.includes(tool.name)) names.push(tool.name);
    }
    for (const removed of message.toolsRemoved ?? []) {
      const index = names.indexOf(removed.name);
      if (index >= 0) names.splice(index, 1);
    }
  }
  return names;
}

export function thinkingBlocks(messages: AgentMessage[]): string[] {
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "thinking") blocks.push(`${block.thinkingSignature ?? ""}:${block.thinking}`);
    }
  }
  return blocks;
}

export function blocksPreserved(before: string[], after: string[]): boolean {
  let from = 0;
  for (const block of before) {
    const found = after.indexOf(block, from);
    if (found < 0) return false;
    from = found + 1;
  }
  return true;
}

export function continuityHeld(before: Continuity, after: Continuity): {
  systemPromptStable: boolean;
  toolOrderStable: boolean;
  reasoningPreserved: boolean | null;
} {
  return {
    systemPromptStable: before.systemPrompt.length > 0 && before.systemPrompt === after.systemPrompt,
    toolOrderStable: before.toolNames.length > 0 && before.toolNames.join("\n") === after.toolNames.join("\n"),
    reasoningPreserved: before.thinking.length === 0 ? null : blocksPreserved(before.thinking, after.thinking),
  };
}

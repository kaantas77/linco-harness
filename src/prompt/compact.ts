import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { clip } from "../json.js";

export interface CompactOptions {
  maxChars: number;
  keepHead?: number;
  keepTail?: number;
  /** When set, compact once the estimated tokens pass 70% of this window. */
  contextWindow?: number;
}

export interface ContextPlan {
  messages: AgentMessage[];
  compacted: boolean;
  beforeChars: number;
  afterChars: number;
  beforeTokens: number;
  afterTokens: number;
  droppedMessages: number;
  shrunkResults: number;
}

/** Coarse stand-in for a tokenizer. Four serialized characters count as one token. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Build the model request. The stored transcript is not modified.
 * The leading system message stays the same object. Tool calls stay paired with their results.
 */
export function planContext(messages: AgentMessage[], options: CompactOptions): ContextPlan {
  const beforeChars = JSON.stringify(messages).length;
  const beforeTokens = estimateTokens(beforeChars);
  const same: ContextPlan = {
    messages,
    compacted: false,
    beforeChars,
    afterChars: beforeChars,
    beforeTokens,
    afterTokens: beforeTokens,
    droppedMessages: 0,
    shrunkResults: 0,
  };
  const keepHead = options.keepHead ?? 1;
  const keepTail = options.keepTail ?? 8;
  const tokenCeiling = options.contextWindow === undefined ? undefined : Math.floor(options.contextWindow * 0.7);
  const overChars = beforeChars > options.maxChars;
  const overTokens = tokenCeiling !== undefined && beforeTokens > tokenCeiling;
  if ((!overChars && !overTokens) || messages.length <= keepHead + keepTail) return same;

  const tailStart = pairSafeTail(messages, keepTail);
  const keep = new Set<number>();
  for (let index = 0; index < Math.min(keepHead, messages.length); index += 1) keep.add(index);
  const firstUser = messages.findIndex((message, index) => index >= keepHead && message.role === "user");
  if (firstUser >= 0 && firstUser < tailStart) keep.add(firstUser);
  for (let index = tailStart; index < messages.length; index += 1) keep.add(index);
  for (const index of [...keep]) {
    const message = messages[index];
    if (!message || message.role !== "toolResult") continue;
    const callAt = messages.findIndex((item) => toolCallIds(item).includes(message.toolCallId));
    if (callAt >= 0) keep.add(callAt);
  }

  const omitted = messages.filter((_, index) => !keep.has(index));
  if (omitted.length === 0) return same;
  const marker = compactionMarker(omitted);
  const request: AgentMessage[] = [];
  let inserted = false;
  for (let index = 0; index < messages.length; index += 1) {
    if (keep.has(index)) {
      const message = messages[index];
      if (message) request.push(message);
      continue;
    }
    if (!inserted) {
      request.push(marker);
      inserted = true;
    }
  }
  const shrunk = shrinkOldResults(request, options.maxChars);
  const afterChars = JSON.stringify(shrunk.messages).length;
  return {
    messages: shrunk.messages,
    compacted: true,
    beforeChars,
    afterChars,
    beforeTokens,
    afterTokens: estimateTokens(afterChars),
    droppedMessages: omitted.length,
    shrunkResults: shrunk.shrunkResults,
  };
}

export function compactForRequest(messages: AgentMessage[], options: CompactOptions): AgentMessage[] {
  return planContext(messages, options).messages;
}

function pairSafeTail(messages: AgentMessage[], keepTail: number): number {
  let start = Math.max(0, messages.length - keepTail);
  let guard = 0;
  while (start > 0 && guard < messages.length) {
    guard += 1;
    const message = messages[start];
    if (!message || message.role !== "toolResult") break;
    const callAt = messages.findIndex((item, index) => index < start && toolCallIds(item).includes(message.toolCallId));
    if (callAt < 0) break;
    start = callAt;
  }
  return start;
}

function shrinkOldResults(messages: AgentMessage[], maxChars: number): { messages: AgentMessage[]; shrunkResults: number } {
  if (JSON.stringify(messages).length <= maxChars) return { messages, shrunkResults: 0 };
  let shrunkResults = 0;
  let lastResult = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "toolResult") {
      lastResult = index;
      break;
    }
  }
  const next = messages.map((message, index) => {
    if (index === lastResult || message.role !== "toolResult") return message;
    const text = toolText(message);
    if (text.length < 1_500) return message;
    shrunkResults += 1;
    return {
      ...message,
      content: [
        {
          type: "text" as const,
          text: `tool ${message.toolName} output omitted from the model request (${text.length} chars). The session record still has the full output.\n${clip(text, 280)}`,
        },
      ],
    };
  });
  return { messages: next, shrunkResults };
}

function compactionMarker(omitted: AgentMessage[]): AgentMessage {
  const summary = clip(omitted.map((message) => summarize(message)).join("\n"), 4_000);
  return {
    role: "user",
    content: `[linco-compaction]\nEarlier turns were compacted so the request stays inside budget.\n${summary}`,
    timestamp: 0,
  };
}

function summarize(message: AgentMessage): string {
  if (message.role === "user" && typeof message.content === "string") return `user: ${clip(message.content, 180)}`;
  if (message.role === "assistant" && Array.isArray(message.content)) {
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    const thinking = message.content
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking)
      .join(" ");
    const tools = message.content
      .filter((block) => block.type === "toolCall")
      .map((block) => block.name)
      .join(",");
    return `assistant: ${clip(text || thinking, 180)}${tools ? ` tools=${tools}` : ""}`;
  }
  if (message.role === "toolResult") {
    const excerpt = clip(toolText(message), 180);
    return `toolResult: ${message.toolName}${excerpt ? ` ${excerpt}` : ""}`;
  }
  if (message.role === "system") return "system";
  return "message";
}

function toolCallIds(message: AgentMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter((block) => block.type === "toolCall").map((block) => block.id);
}

function toolText(message: AgentMessage): string {
  if (message.role !== "toolResult" || !Array.isArray(message.content)) return "";
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

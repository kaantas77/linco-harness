import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { clip } from "../json.js";

export interface CompactOptions {
  maxChars: number;
  keepHead?: number;
  keepTail?: number;
}

/**
 * Drop the middle of a long transcript and leave the leading system message untouched.
 * The stable prefix can still cache. Bytes after that prefix change, which is the cost of compaction.
 */
export function compactForRequest(messages: AgentMessage[], options: CompactOptions): AgentMessage[] {
  const keepHead = options.keepHead ?? 1;
  const keepTail = options.keepTail ?? 8;
  if (JSON.stringify(messages).length <= options.maxChars) return messages;
  if (messages.length <= keepHead + keepTail) return messages;
  const head = messages.slice(0, keepHead);
  const tail = messages.slice(messages.length - keepTail);
  const middle = messages.slice(keepHead, messages.length - keepTail);
  if (middle.length === 0) return messages;
  const summary = clip(middle.map((message) => summarize(message)).join("\n"), 4_000);
  const marker: AgentMessage = {
    role: "user",
    content: `[linco-compaction]\nEarlier turns were compacted so the request stays inside budget.\n${summary}`,
    timestamp: 0,
  };
  return [...head, marker, ...tail];
}

function summarize(message: AgentMessage): string {
  if (message.role === "user" && typeof message.content === "string") return `user: ${clip(message.content, 180)}`;
  if (message.role === "assistant" && Array.isArray(message.content)) {
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    const tools = message.content
      .filter((block) => block.type === "toolCall")
      .map((block) => block.name)
      .join(",");
    return `assistant: ${clip(text, 180)}${tools ? ` tools=${tools}` : ""}`;
  }
  if (message.role === "toolResult") return `toolResult: ${message.toolName}`;
  if (message.role === "system") return "system";
  return "message";
}

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export function lastAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

export function projectMessages(messages: AgentMessage[]): Array<{ role: string; text: string }> {
  return messages.map((message) => ({ role: message.role, text: messageText(message) }));
}

function messageText(message: AgentMessage): string {
  if (message.role === "user" || message.role === "system") {
    return typeof message.content === "string" ? message.content : "";
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    return message.content
      .map((block) => (block.type === "text" ? block.text : block.type === "toolCall" ? `tool ${block.name}` : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (message.role === "toolResult") {
    return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  }
  return "";
}

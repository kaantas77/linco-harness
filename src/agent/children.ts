import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { clip } from "../json.js";
import type { LincoDb } from "../db/database.js";
import type { Task } from "../types.js";

export const WAIT_PREFIX = "LINCO_WAIT ";

export function waitMarker(taskId: string): string {
  return `${WAIT_PREFIX}${taskId}`;
}

export function childReport(db: LincoDb, task: Task): string {
  const usage = db.usageSummary(task.id);
  const durationMs =
    task.startedAt && task.finishedAt ? Date.parse(task.finishedAt) - Date.parse(task.startedAt) : null;
  return JSON.stringify({
    taskId: task.id,
    status: task.status,
    result: clip(task.resultText ?? "", 2_000),
    error: task.error,
    durationMs,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costUsd: usage.costUsd,
  });
}

/** Replace parked task_wait results with the child report. Tool call ids stay put. */
export function rewriteWaitResults(messages: AgentMessage[], reportFor: (taskId: string) => string | undefined): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== "toolResult") return message;
    const text = toolText(message);
    if (!text.startsWith(WAIT_PREFIX)) return message;
    const taskId = text.slice(WAIT_PREFIX.length).trim();
    const report = reportFor(taskId);
    if (!report) return message;
    return { ...message, content: [{ type: "text", text: report }], isError: false };
  });
}

/** Drop the assistant error Pi records when a resume call fails, so the next attempt can continue. */
export function dropTrailingAssistantError(messages: AgentMessage[]): AgentMessage[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return messages;
  const failed =
    ("errorMessage" in last && Boolean(last.errorMessage)) ||
    ("stopReason" in last && (last.stopReason === "error" || last.stopReason === "aborted"));
  return failed ? messages.slice(0, -1) : messages;
}

function toolText(message: AgentMessage): string {
  if (message.role !== "toolResult") return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

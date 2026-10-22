import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type JsonObject,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";

export interface ScriptCall {
  name: string;
  arguments: JsonObject;
}

export type ScriptStep =
  | { text: string; thinking?: string; usage?: Usage }
  | { calls: ScriptCall[]; usage?: Usage };

export const SCRIPT_MODEL = {
  id: "linco-script",
  name: "Linco Script",
  api: "openai-completions",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as Model<"openai-completions">;

export function zeroUsage(patch: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...patch,
  };
}

let toolCallSerial = 0;

/** Deterministic model used by tests and the offline benchmark. Extra turns after the script end with a short stop. */
export function scriptedStream(steps: ScriptStep[]): StreamFn {
  let index = 0;
  return () => finish(index < steps.length ? steps[index++] : { text: "done" });
}

/** Pick the next scripted turn from the transcript. Parallel tasks can share this without stealing steps. */
export function scriptedReply(decide: (messages: { role: string }[]) => ScriptStep): StreamFn {
  return (_model, context) => finish(decide(context.messages));
}

function finish(step: ScriptStep | undefined) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const message = messageFromStep(step ?? { text: "done" });
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
  });
  return stream;
}

function messageFromStep(step: ScriptStep): AssistantMessage {
  const usage = "usage" in step && step.usage ? step.usage : zeroUsage();
  if ("calls" in step) {
    return {
      role: "assistant",
      content: step.calls.map((call) => ({
        type: "toolCall" as const,
        id: `call_${toolCallSerial++}_${call.name}`,
        name: call.name,
        arguments: call.arguments,
      })),
      api: "openai-completions",
      provider: "deepseek",
      model: SCRIPT_MODEL.id,
      usage,
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
  }
  const content: AssistantMessage["content"] = [];
  if (step.thinking) {
    content.push({ type: "thinking", thinking: step.thinking, thinkingSignature: "reasoning_content" });
  }
  content.push({ type: "text", text: step.text });
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "deepseek",
    model: SCRIPT_MODEL.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

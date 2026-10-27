import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createDeepSeek } from "../llm/deepseek.js";

/** One fresh DeepSeek Flash request. The accessibility tree is not included. */
export async function readPaintedCode(apiKey: string, png: Buffer): Promise<{ text: string; costUsd: number; bytes: number }> {
  const { model, streamFn } = createDeepSeek("deepseek-flash");
  const data = png.toString("base64");
  const stream = await Promise.resolve(streamFn(
    model,
    {
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: [
            { type: "text", text: "Read the four characters painted in this picture. Reply with only those four characters." },
            { type: "image", data, mimeType: "image/png" },
          ],
        },
      ],
    } as TranscriptContext,
    { apiKey },
  ));
  let text = "";
  let costUsd = 0;
  for await (const event of stream) {
    if (event.type === "error") throw new Error(event.error.errorMessage || "vision request failed");
    if (event.type !== "done") continue;
    text = event.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    costUsd = event.message.usage.cost.total;
  }
  return { text, costUsd, bytes: data.length };
}

/** Measurement call. The agent model stays on Pi's DeepSeek stream. detail is sent only on this direct request. */
export async function readPaintedCodeDirect(
  apiKey: string,
  png: Buffer,
  detail: "high" | "low" | "omit",
): Promise<{ text: string; costUsd: number; bytes: number; detail: "high" | "low" | "omit"; reasoning: string }> {
  const data = png.toString("base64");
  const image: { url: string; detail?: "high" | "low" } = { url: `data:image/png;base64,${data}` };
  if (detail !== "omit") image.detail = detail;
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-flash",
      max_tokens: 256,
      thinking: { type: "disabled" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read the four characters painted in this picture. Reply with only those four characters." },
            { type: "image_url", image_url: image },
          ],
        },
      ],
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`vision request failed ${response.status} ${body.slice(0, 180)}`);
  const parsed = JSON.parse(body) as {
    choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
  };
  const message = parsed.choices?.[0]?.message;
  const text = typeof message?.content === "string" ? message.content : "";
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
  const usage = parsed.usage ?? {};
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - hit);
  const costUsd = (miss * 0.3 + hit * 0.006 + (usage.completion_tokens ?? 0) * 1.2) / 1_000_000;
  return { text, costUsd, bytes: data.length, detail, reasoning };
}

/** A wrong guess, or a reply that names more than one code, is not a read. */
export function quotedCode(reply: string, code: string): boolean {
  const tokens = reply.toUpperCase().match(/[A-Z0-9]{4}/g) ?? [];
  return tokens.length === 1 && tokens[0] === code;
}

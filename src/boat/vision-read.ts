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

/** A wrong guess, or a reply that names more than one code, is not a read. */
export function quotedCode(reply: string, code: string): boolean {
  const tokens = reply.toUpperCase().match(/[A-Z0-9]{4}/g) ?? [];
  return tokens.length === 1 && tokens[0] === code;
}

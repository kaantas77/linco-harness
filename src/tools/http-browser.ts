import { clip } from "../json.js";
import type { BrowserProvider, PageSnapshot } from "./browser.js";

const TEXT_LIMIT = 20_000;
const BYTE_LIMIT = 200_000;
const BLOCKED_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "169.254.170.2"]);

/** Stateless HTTP read. A later browser provider can add a persistent profile without changing `web_fetch`. */
export class HttpBrowserProvider implements BrowserProvider {
  readonly id = "http-fetch";

  async fetchPage(url: string, signal?: AbortSignal): Promise<PageSnapshot> {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("only http and https URLs are allowed");
    }
    if (BLOCKED_HOSTS.has(parsed.hostname)) throw new Error("that host is blocked");
    const response = await fetch(parsed, { signal, redirect: "follow" });
    const raw = await readLimited(response);
    const contentType = response.headers.get("content-type") ?? "";
    const text = contentType.includes("html") || raw.trimStart().startsWith("<") ? htmlToText(raw) : raw.trim();
    const clipped = clip(text, TEXT_LIMIT);
    return { url: response.url || parsed.toString(), status: response.status, text: clipped, truncated: clipped !== text };
  }
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < BYTE_LIMIT) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    chunks.push(next.value);
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(concat(chunks)).slice(0, BYTE_LIMIT);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

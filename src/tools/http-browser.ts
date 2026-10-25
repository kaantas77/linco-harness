import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { clip } from "../json.js";
import { inspectDestination, NavigationBlocked, type NavOptions } from "../browser/navigation-policy.js";
import type { BrowserProvider, PageSnapshot } from "./browser.js";

const TEXT_LIMIT = 20_000;
const BYTE_LIMIT = 200_000;
const HOPS = 5;

/** Stateless HTTP read. Each hop is checked again and the socket is pinned to that address. */
export class HttpBrowserProvider implements BrowserProvider {
  readonly id = "http-fetch";

  constructor(private readonly options: NavOptions = {}) {}

  async fetchPage(url: string, signal?: AbortSignal): Promise<PageSnapshot> {
    let current = url;
    for (let hop = 0; hop < HOPS; hop += 1) {
      const destination = await inspectDestination(current, this.options);
      const pin = destination.addresses[0];
      if (!pin) throw new NavigationBlocked("that host did not resolve");
      const response = await requestPinned(destination.url, pin, signal);
      if (response.status >= 300 && response.status < 400) {
        const location = header(response.headers.location);
        if (!location) throw new NavigationBlocked("redirect is missing a location");
        current = new URL(location, destination.url).toString();
        continue;
      }
      const raw = response.body;
      const contentType = header(response.headers["content-type"]) ?? "";
      const text = contentType.includes("html") || raw.trimStart().startsWith("<") ? htmlToText(raw) : raw.trim();
      const clipped = clip(text, TEXT_LIMIT);
      return { url: current, status: response.status, text: clipped, truncated: clipped !== text };
    }
    throw new NavigationBlocked("too many redirects");
  }
}

function requestPinned(
  target: URL,
  pin: string,
  signal?: AbortSignal,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const lib = target.protocol === "https:" ? https : http;
  const family = isIP(pin) === 6 ? 6 : 4;
  const port = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        servername: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { host: target.host, accept: "text/html,text/plain,*/*", "user-agent": "linco-fetch" },
        lookup: (_hostname, _options, callback) => {
          callback(null, pin, family);
        },
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (size >= BYTE_LIMIT) return;
          size += chunk.byteLength;
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).subarray(0, BYTE_LIMIT).toString("utf8"),
          });
        });
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function header(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
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

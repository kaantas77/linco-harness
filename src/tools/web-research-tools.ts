import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { inspectDestination } from "../browser/navigation-policy.js";
import { defineTool } from "./define.js";
import { error, text } from "./files.js";
import type { ToolHost } from "./host.js";

/** Serper and Tavily adapters. A missing key is an error, never a fabricated result. */
export function webResearchTools(host: ToolHost): AgentTool[] {
  if (!host.desktop) return [];
  return [
    defineTool<{ query: string }>({
      name: "web_search",
      label: "Web search",
      description: "Search the public web through Serper. Returns titles, URLs, and snippets. Fails when SERPER_API_KEY is unset.",
      parameters: Type.Object({ query: Type.String() }),
      executionMode: "parallel",
      execute: async (_id, params) => {
        try {
          const rows = await serperSearch(params.query, process.env.SERPER_API_KEY);
          return text(rows.map((row) => `${row.title}\n${row.url}\n${row.snippet}`).join("\n\n") || "no results");
        } catch (caught) {
          return error(caught instanceof Error ? caught.message : String(caught));
        }
      },
    }),
    defineTool<{ url: string }>({
      name: "web_extract",
      label: "Web extract",
      description: "Extract readable text from one public http(s) URL through Tavily. Fails when TAVILY_API_KEY is unset. Private addresses are refused.",
      parameters: Type.Object({ url: Type.String() }),
      executionMode: "parallel",
      execute: async (_id, params) => {
        try {
          await inspectDestination(params.url, { allowLoopback: host.allowLoopback });
          const page = await tavilyExtract(params.url, process.env.TAVILY_API_KEY);
          return text(`${page.title}\n${page.url}\n${page.text}`);
        } catch (caught) {
          return error(caught instanceof Error ? caught.message : String(caught));
        }
      },
    }),
  ];
}

export async function serperSearch(query: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<Array<{ title: string; url: string; snippet: string }>> {
  if (!apiKey) throw new Error("SERPER_API_KEY is unset");
  const response = await fetchImpl("https://google.serper.dev/search", {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ q: query.slice(0, 300) }),
  });
  if (!response.ok) throw new Error(`web search failed ${response.status}`);
  const body = await response.json() as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
  return (body.organic ?? []).slice(0, 5).map((row) => ({
    title: row.title ?? "",
    url: row.link ?? "",
    snippet: row.snippet ?? "",
  }));
}

export async function tavilyExtract(url: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<{ title: string; url: string; text: string }> {
  if (!apiKey) throw new Error("TAVILY_API_KEY is unset");
  const response = await fetchImpl("https://api.tavily.com/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, urls: [url] }),
  });
  if (!response.ok) throw new Error(`web extract failed ${response.status}`);
  const body = await response.json() as { results?: Array<{ title?: string; url?: string; raw_content?: string }> };
  const first = body.results?.[0];
  return { title: first?.title ?? "", url: first?.url ?? url, text: (first?.raw_content ?? "").slice(0, 8_000) };
}

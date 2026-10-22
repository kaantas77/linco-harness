import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNavigable } from "../src/browser/navigation-policy.js";
import { clickBrowser, closeTaskBrowser, fillBrowser, openBrowser, snapshotBrowser, tabsBrowser } from "../src/browser/session.js";
import { zeroUsage } from "../src/llm/scripted.js";
import { buildStablePrompt } from "../src/prompt/layout.js";
import type { ToolHost } from "../src/tools/host.js";
import { toolsForPrompt, withBrowserToolset } from "../src/tools/toolset.js";
import { withHarness } from "./helpers.js";

const usage = zeroUsage({
  input: 50,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 60,
  cost: { input: 0.00001, output: 0.00001, cacheRead: 0, cacheWrite: 0, total: 0.00002 },
});

describe("browser navigation policy", () => {
  it("allows loopback and refuses private and metadata targets", async () => {
    await expect(assertNavigable("http://127.0.0.1:9/form")).resolves.toBeTruthy();
    await expect(assertNavigable("http://localhost/")).resolves.toBeTruthy();
    await expect(assertNavigable("http://10.1.1.1/")).rejects.toThrow(/blocked/);
    await expect(assertNavigable("http://169.254.169.254/latest")).rejects.toThrow(/blocked/);
    await expect(assertNavigable("http://metadata.google.internal/")).rejects.toThrow(/blocked/);
    await expect(assertNavigable("file:///etc/passwd")).rejects.toThrow(/http/);
  });
});

describe("browser toolset", () => {
  it("keeps the v1 prompt and tool names as a prefix of v2", () => {
    const v1 = buildStablePrompt([{ name: "file-ops", description: "Edit files" }]);
    const v2 = withBrowserToolset(v1);
    expect(v2.startsWith(`${v1}\n`)).toBe(true);
    expect(v1).not.toContain("linco-toolset:");
    const host = { workspaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), "linco-tools-")) } as ToolHost;
    const v1Names = toolsForPrompt(host, v1).map((tool) => tool.name);
    const v2Names = toolsForPrompt(host, v2).map((tool) => tool.name);
    expect(v2Names.slice(0, v1Names.length)).toEqual(v1Names);
    expect(v1Names).not.toContain("browser_open");
    expect(v2Names.slice(v1Names.length)).toEqual([
      "browser_open",
      "browser_goto",
      "browser_snapshot",
      "browser_read",
      "browser_click",
      "browser_fill",
      "browser_press",
      "browser_scroll",
      "browser_tabs",
      "browser_screenshot",
      "browser_verify",
    ]);
  });
});

describe("playwright browser", () => {
  it("fills a form from snapshot refs, switches tabs, and blocks a second profile user", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "linco-browser-"));
    const seen: string[] = [];
    const site = await listen((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/done") {
        seen.push(url.searchParams.get("email") ?? "");
        response.end("<title>Saved</title><h1>Saved</h1>");
        return;
      }
      if (url.pathname === "/other") {
        response.end("<title>Other</title><h1>Other page</h1>");
        return;
      }
      response.end(`<!doctype html><title>Contact</title><h1>Contact</h1>
        <form action="/done" method="get"><label for="email">Email</label><input id="email" name="email" /><button type="submit">Save</button></form>`);
    });
    const signal = new AbortController().signal;
    const first = { workspaceRoot: workspace, taskId: "task-a", signal };
    try {
      const opened = await openBrowser(first, site.url);
      const email = refFor(opened.text, "textbox", "Email");
      await fillBrowser(first, { ref: email.ref, snapshotId: email.snapshotId, text: "ada@example.com" });
      const again = await snapshotBrowser(first);
      const save = refFor(again.text, "button", "Save");
      await clickBrowser(first, { ref: save.ref, snapshotId: save.snapshotId });
      await expect(fillBrowser(first, { ref: save.ref, snapshotId: save.snapshotId, text: "nope" })).rejects.toThrow(/stale/);
      const verified = await snapshotBrowser(first);
      expect(verified.url).toContain("/done");
      expect(verified.title).toBe("Saved");
      expect(seen).toEqual(["ada@example.com"]);
      await tabsBrowser(first, { action: "open", url: new URL("/other", site.url).toString() });
      const tabs = await tabsBrowser(first, { action: "list" });
      expect(tabs).toContain("Other");
      await tabsBrowser(first, { action: "select", index: 0 });
      const listed = await tabsBrowser(first, { action: "list" });
      expect(listed.split("\n").length).toBe(2);
      await expect(openBrowser({ workspaceRoot: workspace, taskId: "task-b", signal }, site.url)).rejects.toThrow(/in use/);
    } finally {
      await closeTaskBrowser("task-a");
      await closeTaskBrowser("task-b");
      await site.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it("stops a navigation when the task is cancelled", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "linco-cancel-"));
    const site = await listen((_request, response) => {
      response.end("<title>Ready</title><h1>Ready</h1>");
    });
    const abort = new AbortController();
    const pending = openBrowser({ workspaceRoot: workspace, taskId: "slow", signal: abort.signal }, `${site.url}slow`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    abort.abort();
    await expect(pending).rejects.toThrow();
    await closeTaskBrowser("slow");
    const next = new AbortController();
    await openBrowser({ workspaceRoot: workspace, taskId: "next", signal: next.signal }, site.url);
    await closeTaskBrowser("next");
    next.abort();
    await site.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 30_000);

  it("records a successful form run with duration and scripted token use", async () => {
    const seen: string[] = [];
    const site = await listen((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/done") {
        seen.push(url.searchParams.get("email") ?? "");
        response.end("<title>Saved</title><h1>Saved</h1>");
        return;
      }
      response.end(`<!doctype html><title>Contact</title><h1>Contact</h1>
        <form action="/done" method="get"><label for="email">Email</label><input id="email" name="email" /><button type="submit">Save</button></form>`);
    });
    const started = Date.now();
    try {
      await withHarness(
        async (harness) => {
          const user = harness.createUser("Ada");
          const session = harness.createSession(user.id);
          expect(session.systemPrompt).toContain("linco-toolset: v2-browser");
          const task = await harness.submit(session.id, "Save the contact form", { waitMs: 30_000 });
          expect(task.status).toBe("succeeded");
          expect(task.firstResponseMs).not.toBeNull();
          expect(Date.now() - started).toBeGreaterThan(0);
          const summary = harness.db.usageSummary(task.id);
          expect(summary.inputTokens).toBe(50);
          expect(summary.outputTokens).toBe(10);
          expect(summary.costUsd).toBeCloseTo(0.00002);
          expect(seen).toEqual(["ada@example.com"]);
          const verify = harness.db.listTraces(task.id).find((trace) => trace.kind === "browser" && trace.name === "browser_verify");
          expect(verify && typeof verify.data === "object" && verify.data && !("error" in verify.data)).toBe(true);
          expect(fs.existsSync(path.join(user.workspacePath, ".linco", "shots", "form.png"))).toBe(true);
        },
        {
          steps: [
            { calls: [{ name: "browser_open", arguments: { url: site.url } }] },
            { calls: [{ name: "browser_fill", arguments: { role: "textbox", name: "Email", text: "ada@example.com" } }] },
            { calls: [{ name: "browser_click", arguments: { role: "button", name: "Save" } }] },
            { calls: [{ name: "browser_verify", arguments: { urlIncludes: "/done", title: "Saved", role: "heading", name: "Saved" } }] },
            { calls: [{ name: "browser_screenshot", arguments: { path: ".linco/shots/form.png" } }] },
            { text: "saved the form", usage },
          ],
        },
      );
    } finally {
      await site.close();
    }
  }, 60_000);
});

function refFor(snapshot: string, role: string, name: string): { ref: string; snapshotId: number } {
  const snapshotId = Number(snapshot.match(/snapshot #(\d+)/)?.[1]);
  const line = snapshot.split("\n").find((item) => item.includes(role) && item.includes(name) && item.includes("[ref="));
  const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1];
  if (!ref || !snapshotId) throw new Error(snapshot);
  return { ref, snapshotId };
}

function listen(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    if (request.url === "/slow") return;
    handler(request, response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

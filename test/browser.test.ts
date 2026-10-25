import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeJevTask, runDelegatedJev } from "../src/browser/jev-delegation.js";
import { parseBrowserSnapshot } from "../src/browser/jev-run.js";
import { assertNavigable, snapshotHostAllowed } from "../src/browser/navigation-policy.js";
import { clickBrowser, closeTaskBrowser, fillBrowser, openBrowser, snapshotBrowser, tabsBrowser } from "../src/browser/session.js";
import { zeroUsage } from "../src/llm/scripted.js";
import { buildStablePrompt } from "../src/prompt/layout.js";
import type { ToolHost } from "../src/tools/host.js";
import { jevTools } from "../src/tools/browser-tools.js";
import { toolsForPrompt, withBrowserToolset, withJevToolset } from "../src/tools/toolset.js";
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
    await expect(assertNavigable("http://127.0.0.1:9/form")).rejects.toThrow(/blocked/);
    await expect(assertNavigable("http://127.0.0.1:9/form", { allowLoopback: true })).resolves.toBeTruthy();
    await expect(assertNavigable("http://localhost/", { allowLoopback: true })).resolves.toBeTruthy();
    await expect(assertNavigable("http://10.1.1.1/", { allowLoopback: true })).rejects.toThrow(/blocked/);
    await expect(assertNavigable("http://169.254.169.254/latest")).rejects.toThrow(/blocked/);
    await expect(assertNavigable("http://metadata.google.internal/")).rejects.toThrow(/blocked/);
    await expect(assertNavigable("file:///etc/passwd")).rejects.toThrow(/http/);
    expect(snapshotHostAllowed("http://127.0.0.1:9/form")).toBe(false);
    expect(snapshotHostAllowed("http://127.0.0.1:9/form", { allowLoopback: true })).toBe(true);
    expect(snapshotHostAllowed("http://10.1.1.1/", { allowLoopback: true })).toBe(false);
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
    const v3 = withJevToolset(v1);
    expect(v3.startsWith(`${v2}\n`)).toBe(true);
    expect(v3).toContain("linco-toolset: v3-jev");
    expect(toolsForPrompt(host, v3).map((tool) => tool.name).slice(v2Names.length)).toEqual(["browser_select", "jev_run"]);
  });

  it("does not call Jev when TYPESAFE_API_KEY is absent", async () => {
    const previous = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    const traces: Array<{ name?: string; data?: unknown }> = [];
    const host = {
      workspaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), "linco-jev-key-")),
      taskId: "task-key",
      signal: new AbortController().signal,
      db: { addTrace: (trace: { name?: string; data?: unknown }) => traces.push(trace) },
    } as ToolHost;
    try {
      const jev = jevTools(host).find((tool) => tool.name === "jev_run");
      const result = await jev?.execute("call", { goal: "Open the page", expected: { title: "Saved" } });
      const body = JSON.stringify(result);
      expect(body).toContain("TYPESAFE_API_KEY is not set");
      expect(body).toContain("Jev did not run");
      expect(traces.some((trace) => trace.name === "jev_run")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
    }
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
    const first = { workspaceRoot: workspace, taskId: "task-a", signal, allowLoopback: true };
    try {
      const opened = await openBrowser(first, site.url);
      expect(parseBrowserSnapshot(opened.text)?.elements.some((element) => element.role === "textbox" && element.name === "Email")).toBe(true);
      const email = refFor(opened.text, "textbox", "Email");
      await fillBrowser(first, { ref: email.ref, snapshotId: email.snapshotId, text: "ada@example.com" });
      const again = await snapshotBrowser(first);
      const save = refFor(again.text, "button", "Save");
      const clicked = await clickBrowser(first, { ref: save.ref, snapshotId: save.snapshotId });
      expect(clicked).toContain("/done");
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
      await expect(openBrowser({ workspaceRoot: workspace, taskId: "task-b", signal, allowLoopback: true }, site.url)).rejects.toThrow(/in use/);
    } finally {
      await closeTaskBrowser("task-a");
      await closeTaskBrowser("task-b");
      await site.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it("lets Jev fill and submit the form, then checks the saved email", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "linco-jev-"));
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
    const target = { workspaceRoot: workspace, taskId: "task-jev", signal: new AbortController().signal, allowLoopback: true };
    try {
      await openBrowser(target, site.url);
      const result = await runDelegatedJev({
        taskId: target.taskId,
        key: "scripted-jev",
        target,
        raw: {
          goal: "Fill Email with ada@example.com then click Save",
          expected: { title: "Saved" },
          inputs: [{ role: "textbox", name: "Email", value: "ada@example.com" }],
          maxActions: 4,
        },
        fetchImpl: async (_url, init) => {
          const criteria = JSON.parse(String(init?.body)).questions.next_action.criteria as Record<string, string>;
          const choices = Object.keys(criteria);
          const choice = choices.find((key) => key.startsWith("FILL_") && criteria[key]?.includes("Email"))
            ?? choices.find((key) => criteria[key] === "button: Save")
            ?? "ESCALATE";
          return Response.json({
            answers: { next_action: { choice, confidence: 1, probabilities: Object.fromEntries(choices.map((key) => [key, key === choice ? 1 : 0])) } },
            usage: { input_tokens: 11, output_tokens: 3 },
          });
        },
      });
      expect(result.status).toBe("done");
      expect(result.reason).toBe("destination verified by fresh browser snapshot");
      expect(result.typesafeCalls).toBe(2);
      expect(result.actions).toBe(2);
      expect(result.title).toBe("Saved");
      expect(seen).toEqual(["ada@example.com"]);
    } finally {
      closeJevTask(target.taskId);
      await closeTaskBrowser(target.taskId);
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
    const pending = openBrowser({ workspaceRoot: workspace, taskId: "slow", signal: abort.signal, allowLoopback: true }, `${site.url}slow`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    abort.abort();
    await expect(pending).rejects.toThrow();
    await closeTaskBrowser("slow");
    const next = new AbortController();
    await openBrowser({ workspaceRoot: workspace, taskId: "next", signal: next.signal, allowLoopback: true }, site.url);
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
          expect(session.systemPrompt).toContain("linco-toolset: v3-jev");
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
  const line = snapshot.split("\n").find((item) => new RegExp(`^- \\[[^\\]]+\\] ${role}(?: disabled)?: ${name}$`).test(item));
  const ref = line?.match(/^- \[([^\]]+)\]/)?.[1];
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

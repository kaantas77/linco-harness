import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeJevTask, jevKey, runDelegatedJev } from "../src/browser/jev-delegation.js";
import { closeTaskBrowser, openBrowser } from "../src/browser/session.js";

const live = process.env.LINCO_JEV_LIVE === "1" && Boolean(jevKey());

describe.skipIf(!live)("live Jev", () => {
  it("fills the local form through TypeSafe jev-latest", async () => {
    const key = jevKey();
    if (!key) throw new Error("TYPESAFE_API_KEY is not set");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "linco-jev-live-"));
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
    const target = { workspaceRoot: workspace, taskId: "task-jev-live", signal: new AbortController().signal, allowLoopback: true };
    try {
      await openBrowser(target, site.url);
      const result = await runDelegatedJev({
        taskId: target.taskId,
        key,
        target,
        raw: {
          goal: "Fill the Email textbox with ada@example.com, then click Save.",
          expected: { title: "Saved" },
          inputs: [{ role: "textbox", name: "Email", value: "ada@example.com" }],
          maxActions: 4,
        },
      });
      expect({
        status: result.status,
        reason: result.reason,
        actions: result.actions,
        typesafeCalls: result.typesafeCalls,
        typesafeInputTokens: result.typesafeInputTokens,
        typesafeOutputTokens: result.typesafeOutputTokens,
        title: result.title,
        seen,
      }).toEqual({
        status: "done",
        reason: "destination verified by fresh browser snapshot",
        actions: expect.any(Number),
        typesafeCalls: expect.any(Number),
        typesafeInputTokens: expect.any(Number),
        typesafeOutputTokens: expect.any(Number),
        title: "Saved",
        seen: ["ada@example.com"],
      });
      expect(result.actions).toBeGreaterThan(0);
      expect(result.typesafeCalls).toBeGreaterThan(0);
    } finally {
      closeJevTask(target.taskId);
      await closeTaskBrowser(target.taskId);
      await site.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 90_000);
});

function listen(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

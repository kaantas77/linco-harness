import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  clickBrowser,
  closeTaskBrowser,
  fillBrowser,
  openBrowser,
  pressBrowser,
  readBrowser,
  screenshotBrowser,
  scrollBrowser,
  selectBrowser,
  snapshotBrowser,
  tabsBrowser,
  verifyBrowser,
  type BrowserTarget,
} from "../browser/session.js";
import { jevKey, runDelegatedJev } from "../browser/jev-delegation.js";
import { resolveInside } from "../security/workspace.js";
import { defineTool } from "./define.js";
import { error, text } from "./files.js";
import type { ToolHost } from "./host.js";

/** Appended after the v1 tool list. Order is part of the v2 cache prefix. */
export function browserTools(host: ToolHost): AgentTool[] {
  const target = (): BrowserTarget => ({
    workspaceRoot: host.workspaceRoot,
    taskId: host.taskId,
    signal: host.signal,
    allowLoopback: host.allowLoopback,
  });
  const run = runner(host);

  return [
    defineTool<{ url?: string }>({
      name: "browser_open",
      label: "Open browser",
      description: "Open this user's persistent browser profile at workspace/.linco/browser. Pass url to load the first page. Fails if another task already holds the profile.",
      parameters: Type.Object({ url: Type.Optional(Type.String()) }),
      executionMode: "sequential",
      execute: async (_id, params) => run("browser_open", async () => ({ text: (await openBrowser(target(), params.url)).text })),
    }),
    defineTool<{ url: string }>({
      name: "browser_goto",
      label: "Go to URL",
      description: "Navigate the current tab to an http or https URL. Private networks and metadata hosts are refused.",
      parameters: Type.Object({ url: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => run("browser_goto", async () => ({ text: (await openBrowser(target(), params.url)).text })),
    }),
    defineTool<Record<string, never>>({
      name: "browser_snapshot",
      label: "Snapshot page",
      description: "Read the current page as a semantic snapshot. Lines look like `- [b12] button: Save`. Pass that ref with this snapshotId.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => run("browser_snapshot", async () => ({ text: (await snapshotBrowser(target())).text })),
    }),
    defineTool<Record<string, never>>({
      name: "browser_read",
      label: "Read page text",
      description: "Read the visible text of the current tab.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () =>
        run("browser_read", async () => {
          const page = await readBrowser(target());
          return { text: `${page.title}\n${page.url}\n${page.text}` };
        }),
    }),
    defineTool<{ ref?: string; snapshotId?: number; role?: string; name?: string }>({
      name: "browser_click",
      label: "Click element",
      description: "Click one element. Prefer ref plus the snapshotId from the latest browser_snapshot. role and name are the accessible name.",
      parameters: Type.Object({
        ref: Type.Optional(Type.String()),
        snapshotId: Type.Optional(Type.Number()),
        role: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => run("browser_click", async () => ({ text: await clickBrowser(target(), params) })),
    }),
    defineTool<{ ref?: string; snapshotId?: number; role?: string; name?: string; text: string }>({
      name: "browser_fill",
      label: "Fill element",
      description: "Type into one textbox. Prefer ref plus snapshotId. role and name select by accessible name when the ref is not used.",
      parameters: Type.Object({
        ref: Type.Optional(Type.String()),
        snapshotId: Type.Optional(Type.Number()),
        role: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        text: Type.String(),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => run("browser_fill", async () => ({ text: await fillBrowser(target(), params) })),
    }),
    defineTool<{ key: string }>({
      name: "browser_press",
      label: "Press key",
      description: "Press a keyboard key in the current tab, for example Enter.",
      parameters: Type.Object({ key: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => run("browser_press", async () => ({ text: await pressBrowser(target(), params.key) })),
    }),
    defineTool<{ direction?: string }>({
      name: "browser_scroll",
      label: "Scroll page",
      description: "Scroll the current tab up or down.",
      parameters: Type.Object({ direction: Type.Optional(Type.String()) }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        run("browser_scroll", async () => {
          const direction = params.direction === "up" ? "up" : "down";
          return { text: await scrollBrowser(target(), direction) };
        }),
    }),
    defineTool<{ action: string; url?: string; index?: number }>({
      name: "browser_tabs",
      label: "Manage tabs",
      description: "List, open, select, or close tabs. action is list, open, select, or close. open needs url. select and close need index.",
      parameters: Type.Object({
        action: Type.String(),
        url: Type.Optional(Type.String()),
        index: Type.Optional(Type.Number()),
      }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        run("browser_tabs", async () => {
          const action = params.action;
          if (action !== "list" && action !== "open" && action !== "select" && action !== "close") {
            throw new Error("action must be list, open, select, or close");
          }
          return { text: await tabsBrowser(target(), { action, url: params.url, index: params.index }) };
        }),
    }),
    defineTool<{ path?: string }>({
      name: "browser_screenshot",
      label: "Screenshot",
      description: "Save a PNG of the current tab inside the workspace. Defaults to .linco/shots/page.png.",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        run("browser_screenshot", async () => {
          const relative = params.path ?? path.join(".linco", "shots", "page.png");
          const file = resolveInside(host.workspaceRoot, relative);
          await screenshotBrowser(target(), file);
          return { text: `saved ${relative}`, details: { path: relative } };
        }),
    }),
    defineTool<{ urlIncludes?: string; title?: string; role?: string; name?: string }>({
      name: "browser_verify",
      label: "Verify page",
      description: "Take a fresh snapshot and check the URL, title, or a single accessible element. Use this to confirm the page actually changed.",
      parameters: Type.Object({
        urlIncludes: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        role: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => run("browser_verify", async () => ({ text: (await verifyBrowser(target(), params)).text })),
    }),
  ];
}

/** v3 only. Jev chooses the action; browser_select repairs a native dropdown after an escalation. */
export function jevTools(host: ToolHost): AgentTool[] {
  const target = (): BrowserTarget => ({
    workspaceRoot: host.workspaceRoot,
    taskId: host.taskId,
    signal: host.signal,
    allowLoopback: host.allowLoopback,
  });
  const run = runner(host);
  return [
    defineTool<{ ref?: string; snapshotId?: number; option: string }>({
      name: "browser_select",
      label: "Select option",
      description: "Choose one exact enabled option label from a native select in the latest semantic snapshot. Pass ref and snapshotId. Custom dropdowns stay a click sequence.",
      parameters: Type.Object({
        ref: Type.Optional(Type.String()),
        snapshotId: Type.Optional(Type.Number()),
        option: Type.String(),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => run("browser_select", async () => ({ text: await selectBrowser(target(), params) })),
    }),
    defineTool<{ goal: string; expected: Record<string, unknown>; inputs?: Array<{ role: string; name: string; value: string }>; maxActions?: number }>({
      name: "jev_run",
      label: "Run Jev",
      description:
        "Execute one bounded browser subgoal with Jev. TypeSafe jev-latest chooses CLICK, FILL, or SELECT from the semantic snapshot, then a fresh snapshot verifies expected. Open the page first. On escalate, repair with browser tools and delegate a revised goal. Passwords and payment are not sent. Requires TYPESAFE_API_KEY.",
      parameters: Type.Object({
        goal: Type.String(),
        expected: Type.Object({
          url: Type.Optional(Type.String()),
          documentUrl: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          element: Type.Optional(Type.Unknown()),
          absentElement: Type.Optional(Type.Unknown()),
        }),
        inputs: Type.Optional(Type.Array(Type.Object({ role: Type.String(), name: Type.String(), value: Type.String() }))),
        maxActions: Type.Optional(Type.Number()),
      }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        run("jev_run", async () => {
          const key = jevKey();
          if (!key) throw new Error("TYPESAFE_API_KEY is not set. Jev did not run.");
          const result = await runDelegatedJev({ taskId: host.taskId, raw: params, key, target: target() });
          return {
            text: JSON.stringify(result),
            details: {
              status: result.status,
              reason: result.reason,
              actions: result.actions,
              typesafeCalls: result.typesafeCalls,
              elapsedMs: result.elapsedMs,
            },
          };
        }),
    }),
  ];
}

function runner(host: ToolHost) {
  return async (name: string, action: () => Promise<{ text: string; details?: Record<string, unknown> }>) => {
    const startedAt = new Date().toISOString();
    try {
      const result = await action();
      host.db.addTrace({
        taskId: host.taskId,
        kind: "browser",
        name,
        startedAt,
        endedAt: new Date().toISOString(),
        data: result.details ?? {},
        ...(host.claim ? { claim: host.claim } : {}),
      });
      return text(result.text, result.details);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      host.db.addTrace({
        taskId: host.taskId,
        kind: "browser",
        name,
        startedAt,
        endedAt: new Date().toISOString(),
        data: { error: message },
        ...(host.claim ? { claim: host.claim } : {}),
      });
      if (host.signal.aborted) await closeTaskBrowser(host.taskId);
      return error(message);
    }
  };
}

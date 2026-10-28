import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { DesktopObservation } from "../boat/client.js";
import { openVerifiedPage, readIds } from "../boat/desktop-flow.js";
import { browserAppName } from "../security/policy.js";
import { defineTool } from "./define.js";
import { error, text } from "./files.js";
import type { ToolHost } from "./host.js";

/** Appended only while the task is bound to a Boat computer. Local sessions keep the previous tool list. */
export function desktopTools(host: ToolHost): AgentTool[] {
  const desktop = host.desktop;
  if (!desktop) return [];
  const call = (tool: string, args: Record<string, unknown>) => desktop.call(tool, args);
  const editFile = defineTool<{ path: string; text: string }>({
    name: "desktop_edit_file",
    label: "Desktop edit file",
    description: "Open a new file in the desktop editor, type the text, save it, and read the file back. The tool fails unless that read contains the text. Use this to write a file on the desktop. Needs user approval.",
    parameters: Type.Object({ path: Type.String(), text: Type.String() }),
    executionMode: "sequential",
    execute: async (_id, params) =>
      guard(async () => {
        if (!desktop.editFile) return error("desktop edit is unavailable");
        const saved = await desktop.editFile(params.path, params.text);
        if (!saved.ok) return error(saved.detail);
        return text(saved.detail);
      }),
  });
  return [
    editFile,
    defineTool<Record<string, never>>({
      name: "desktop_state",
      label: "Desktop state",
      description: "Read the Boat desktop accessibility tree. This does not type or save a file.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => guard(() => call("get_desktop_state", {}).then((observation) => show(observation, desktop.acceptsImages))),
    }),
    defineTool<{ windowId?: string }>({
      name: "desktop_tree",
      label: "Window tree",
      description: "Read one window's accessibility tree. Omit windowId to read the desktop.",
      parameters: Type.Object({ windowId: Type.Optional(Type.String()) }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        guard(async () => {
          const observation = params.windowId
            ? await call("get_window_state", { window_id: params.windowId })
            : await call("get_desktop_state", {});
          return show(observation, desktop.acceptsImages);
        }),
    }),
    defineTool<{ windowId?: string }>({
      name: "desktop_screenshot",
      label: "Desktop screenshot",
      description: "Capture the Boat desktop. When the model cannot accept images, only the accessibility tree is returned.",
      parameters: Type.Object({ windowId: Type.Optional(Type.String()) }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        guard(async () => {
          const observation = params.windowId
            ? await call("get_window_state", { window_id: params.windowId })
            : await call("get_desktop_state", {});
          return show(observation, desktop.acceptsImages);
        }),
    }),
    defineTool<{ x: number; y: number }>({
      name: "desktop_click",
      label: "Desktop click",
      description: "Click the Boat desktop at x, y. Needs user approval.",
      parameters: Type.Object({ x: Type.Number(), y: Type.Number() }),
      executionMode: "sequential",
      execute: async (_id, params) => guard(async () => show(await call("click", await front(call, { x: params.x, y: params.y })), false)),
    }),
    defineTool<{ text: string }>({
      name: "desktop_type",
      label: "Desktop type",
      description: "Type text into the focused Boat window. Call desktop_click first so the caret is in that window. Needs user approval.",
      parameters: Type.Object({ text: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => guard(async () => show(await call("type_text", await front(call, { text: params.text })), false)),
    }),
    defineTool<{ app?: string; windowId?: string }>({
      name: "desktop_window",
      label: "Desktop window",
      description: "Launch an app or focus a window on the Boat desktop. Needs user approval.",
      parameters: Type.Object({ app: Type.Optional(Type.String()), windowId: Type.Optional(Type.String()) }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        guard(async () => {
          if (host.browserControl === false && params.app && browserAppName(params.app)) {
            return error("Boat browser control is off for the private pilot.");
          }
          if (!params.app && !params.windowId) return error("app or windowId is required");
          const observation = params.windowId
            ? await call("bring_to_front", { window_id: params.windowId })
            : await call("launch_app", { name: params.app, app: params.app, application: params.app });
          return show(observation, false);
        }),
    }),
    defineTool<{ steps: Array<{ tool: string; text?: string; x?: number; y?: number; key?: string }> }>({
      name: "desktop_batch",
      label: "Desktop sequence",
      description: "Run focus, click, type, and key steps in order on this Boat desktop. Stops at the first error and does not retry. A screenshot is not proof that a file was saved; read the file afterwards.",
      parameters: Type.Object({
        steps: Type.Array(Type.Object({
          tool: Type.String(),
          text: Type.Optional(Type.String()),
          x: Type.Optional(Type.Number()),
          y: Type.Optional(Type.Number()),
          key: Type.Optional(Type.String()),
        })),
      }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        guard(async () => {
          if (host.browserControl === false && /chrome|chromium|launch_app/i.test(JSON.stringify(params.steps))) {
            return error("Boat browser control is off for the private pilot.");
          }
          if (!desktop.sequence) return error("desktop sequence is unavailable");
          const mapped = params.steps.map((step) => ({
            tool: step.tool,
            args: {
              ...(step.text !== undefined ? { text: step.text } : {}),
              ...(step.x !== undefined ? { x: step.x } : {}),
              ...(step.y !== undefined ? { y: step.y } : {}),
              ...(step.key !== undefined ? { key: step.key } : {}),
            },
          }));
          const results = await desktop.sequence(mapped);
          const failed = results.find((step) => !step.ok);
          const lines = results.map((step) => `${step.ok ? "ok" : "failed"} ${step.tool}: ${step.detail}`);
          if (failed) return error(lines.join("\n"));
          return text(lines.join("\n"));
        }),
    }),
    defineTool<{ url: string }>({
      name: "desktop_browser",
      label: "Desktop browser",
      description: "Open a page in the Boat desktop browser. The tool fails unless the accessibility tree or browser state contains the page title. Needs user approval.",
      parameters: Type.Object({ url: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        guard(async () => {
          if (host.browserControl === false) return error("Boat browser control is off for the private pilot.");
          const opened = await openVerifiedPage(
            { call, schema: (name) => desktop.schema?.(name) },
            params.url,
            titleExpect(params.url),
          );
          if (!opened.ok) return error(`${opened.kind}: ${opened.detail}`);
          return text(`title verified\n${opened.detail}`);
        }),
    }),
  ];
}

async function front(call: (tool: string, args: Record<string, unknown>) => Promise<DesktopObservation>, extra: Record<string, unknown>) {
  const state = await call("get_desktop_state", {});
  const ids = readIds(state.text);
  return {
    ...extra,
    ...(ids.pid ? { pid: ids.pid } : {}),
    ...(ids.windowId ? { window_id: ids.windowId } : {}),
    delivery_mode: "foreground",
  };
}

function titleExpect(url: string): RegExp {
  const host = new URL(url).hostname;
  if (host === "example.com" || host.endsWith(".example.com")) return /Example Domain/i;
  return new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

async function guard(fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (caught) {
    return error(caught instanceof Error ? caught.message : String(caught));
  }
}

function show(observation: DesktopObservation, acceptsImages: boolean) {
  const tree = observation.tree || observation.text || "empty desktop";
  const note = observation.image
    ? acceptsImages
      ? "screenshot attached"
      : "model input does not include images; accessibility tree only"
    : "accessibility tree";
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
    { type: "text", text: `${note}\n${tree}` },
  ];
  if (acceptsImages && observation.image) content.push({ type: "image", data: observation.image.data, mimeType: observation.image.mimeType });
  return { content, details: { tree, image: Boolean(acceptsImages && observation.image) } };
}

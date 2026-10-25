import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { DesktopObservation } from "../boat/client.js";
import { defineTool } from "./define.js";
import { error } from "./files.js";
import type { ToolHost } from "./host.js";

/** Appended only while the task is bound to a Boat computer. Local sessions keep the previous tool list. */
export function desktopTools(host: ToolHost): AgentTool[] {
  const desktop = host.desktop;
  if (!desktop) return [];
  const call = (tool: string, args: Record<string, unknown>) => desktop.call(tool, args);
  return [
    defineTool<Record<string, never>>({
      name: "desktop_state",
      label: "Desktop state",
      description: "Read the Boat desktop accessibility tree. This is the Linux computer for this user.",
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
      execute: async (_id, params) => guard(() => call("click", { x: params.x, y: params.y }).then((observation) => show(observation, false))),
    }),
    defineTool<{ text: string }>({
      name: "desktop_type",
      label: "Desktop type",
      description: "Type text on the Boat desktop. Needs user approval.",
      parameters: Type.Object({ text: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => guard(() => call("type_text", { text: params.text }).then((observation) => show(observation, false))),
    }),
    defineTool<{ app?: string; windowId?: string }>({
      name: "desktop_window",
      label: "Desktop window",
      description: "Launch an app or focus a window on the Boat desktop. Needs user approval.",
      parameters: Type.Object({ app: Type.Optional(Type.String()), windowId: Type.Optional(Type.String()) }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        guard(async () => {
          if (!params.app && !params.windowId) return error("app or windowId is required");
          const observation = params.windowId
            ? await call("bring_to_front", { window_id: params.windowId })
            : await call("launch_app", { app: params.app });
          return show(observation, false);
        }),
    }),
    defineTool<{ url: string }>({
      name: "desktop_browser",
      label: "Desktop browser",
      description: "Open a page in the Boat desktop browser and return its title from the accessibility tree. Needs user approval.",
      parameters: Type.Object({ url: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        guard(async () => {
          await call("launch_app", { app: "google-chrome" });
          await call("browser_navigate", { url: params.url });
          return show(await call("get_browser_state", {}), desktop.acceptsImages);
        }),
    }),
  ];
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

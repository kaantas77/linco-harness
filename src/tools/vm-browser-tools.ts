import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { VmBrowserResult } from "../boat/vm-browser.js";
import { defineTool } from "./define.js";
import { error, text } from "./files.js";
import type { ToolHost } from "./host.js";

/** Chrome inside the user's Boat VM. These tools do not launch a browser on the host. */
export function vmBrowserTools(host: ToolHost): AgentTool[] {
  const browser = host.vmBrowser;
  if (!browser) return [];
  const act = async (request: Parameters<NonNullable<ToolHost["vmBrowser"]>["act"]>[0]): Promise<VmBrowserResult> => browser.act(request);
  return [
    defineTool<{ url: string }>({
      name: "vm_browser_goto",
      label: "Open page on the Boat computer",
      description: "Open an http or https URL in this user's isolated Chrome profile on the Boat computer. The window is on that VM desktop. Private addresses are refused. This does not start a browser on the host.",
      parameters: Type.Object({ url: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => guard(async () => text(shown(await act({ op: "goto", url: params.url })))),
    }),
    defineTool<Record<string, never>>({
      name: "vm_browser_read",
      label: "Read the Boat browser page",
      description: "Read the title, URL, and visible text of the Chrome window already open on this user's Boat computer.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => guard(async () => text(shown(await act({ op: "read" })))),
    }),
    defineTool<{ url: string; name: string; text: string; submit?: boolean }>({
      name: "vm_browser_fill",
      label: "Fill a form on the Boat computer",
      description: "Open an http or https URL in the isolated Boat Chrome profile, fill one named field, and optionally submit. The filled value is not proof until vm_browser_read shows it.",
      parameters: Type.Object({
        url: Type.String(),
        name: Type.String(),
        text: Type.String(),
        submit: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        guard(async () => text(shown(await act({ op: "fill", url: params.url, name: params.name, text: params.text, submit: params.submit === true })))),
    }),
  ];
}

function shown(page: VmBrowserResult): string {
  return [page.title ?? "", page.url ?? "", page.text ?? ""].filter(Boolean).join("\n");
}

async function guard<T>(work: () => Promise<T>): Promise<T | ReturnType<typeof error>> {
  try {
    return await work();
  } catch (caught) {
    return error(caught instanceof Error ? caught.message : String(caught));
  }
}

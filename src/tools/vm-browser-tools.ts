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
      description: "Open an http or https URL in the isolated Boat Chrome profile, fill one named field, and optionally submit. The filled value is not proof until a fresh snapshot or the result page shows it.",
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
    defineTool<{ url: string }>({
      name: "browser_navigate",
      label: "Navigate Boat Chrome",
      description: "Open an http or https URL in this user's Boat Chrome through CDP. Returns the real URL, title, snapshotId, and accessibility refs. A private redirect is refused. This does not start a browser on the host.",
      parameters: Type.Object({ url: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => guard(async () => text(snapshotText(await act({ op: "navigate", url: params.url })))),
    }),
    defineTool<Record<string, never>>({
      name: "browser_snapshot",
      label: "Browser accessibility snapshot",
      description: "Read Chrome's accessibility tree for the current Boat tab. Refs look like b123 and work only with the returned snapshotId.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => guard(async () => text(snapshotText(await act({ op: "snapshot" })))),
    }),
    defineTool<{ ref: string; snapshotId: number }>({
      name: "browser_click",
      label: "Click browser ref",
      description: "Click one ref from the latest browser_snapshot. A stale snapshotId is refused. The result is a fresh snapshot.",
      parameters: Type.Object({ ref: Type.String(), snapshotId: Type.Number() }),
      executionMode: "sequential",
      execute: async (_id, params) => guard(async () => text(snapshotText(await act({ op: "clickRef", ref: params.ref, snapshotId: params.snapshotId })))),
    }),
    defineTool<{ ref: string; snapshotId: number; text: string }>({
      name: "browser_fill",
      label: "Fill browser ref",
      description: "Type into one textbox ref from the latest browser_snapshot. The typed characters are not returned. A stale snapshotId is refused.",
      parameters: Type.Object({ ref: Type.String(), snapshotId: Type.Number(), text: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => guard(async () => text(snapshotText(await act({ op: "fillRef", ref: params.ref, snapshotId: params.snapshotId, text: params.text })))),
    }),
    defineTool<{ ref: string; snapshotId: number; value: string }>({
      name: "browser_select",
      label: "Select browser option",
      description: "Choose one option in a select ref from the latest browser_snapshot. A stale snapshotId is refused.",
      parameters: Type.Object({ ref: Type.String(), snapshotId: Type.Number(), value: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params) => guard(async () => text(snapshotText(await act({ op: "selectRef", ref: params.ref, snapshotId: params.snapshotId, value: params.value })))),
    }),
    defineTool<{ url: string; expectedTitle?: string; expectedText?: string }>({
      name: "browser_open_read",
      label: "Open and verify a page",
      description: "Open a public URL and fail unless the real tab URL is same-origin and the optional title or text is present. The model claim is not the check.",
      parameters: Type.Object({
        url: Type.String(),
        expectedTitle: Type.Optional(Type.String()),
        expectedText: Type.Optional(Type.String()),
      }),
      executionMode: "sequential",
      execute: async (_id, params) =>
        guard(async () => {
          const page = await act({ op: "openRead", url: params.url, expectedTitle: params.expectedTitle, expectedText: params.expectedText });
          if (page.verified !== true) return error(`navigation not verified\n${snapshotText(page)}`);
          return text(snapshotText(page));
        }),
    }),
  ];
}

function snapshotText(page: VmBrowserResult): string {
  const snapshot = page.snapshot;
  const lines = [
    page.verified === undefined ? "" : `verified ${page.verified ? "yes" : "no"}`,
    page.title ?? "",
    page.url ?? "",
    snapshot ? `snapshotId ${snapshot.snapshotId}` : "",
    snapshot ? `targetId ${snapshot.targetId}` : "",
    ...(snapshot?.elements ?? []).map((element) => {
      const state = element.disabled ? " disabled" : "";
      const filled = element.filled === undefined ? "" : element.filled ? " filled" : " empty";
      return `- [${element.ref}] ${element.role}: ${element.name}${state}${filled}`;
    }),
  ];
  return lines.filter(Boolean).join("\n");
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

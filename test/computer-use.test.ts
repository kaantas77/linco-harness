import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DesktopObservation } from "../src/boat/client.js";
import { captureViewer, judge, openVerifiedPage, readWindows, typeIntoEditor, type DriverCaller } from "../src/boat/desktop-flow.js";
import { fitArguments } from "../src/boat/driver-schema.js";
import { cropForReading, inspectPng, labelPng } from "../src/boat/label-png.js";
import { BoatSandboxManager } from "../src/boat/manager.js";
import { mcpCommand } from "../src/boat/mcp.js";
import { quotedCode } from "../src/boat/vision-read.js";
import { LincoDb } from "../src/db/database.js";
import { desktopTools } from "../src/tools/desktop-tools.js";
import type { ToolHost } from "../src/tools/host.js";
import { FakeBoat } from "./boat-fake.js";

describe("computer use reliability", () => {
  it("rejects a desktop call whose required fields are missing", async () => {
    const fitted = fitArguments(
      { name: "click", required: ["pid", "x", "y"], properties: ["pid", "x", "y", "window_id"] },
      { x: 4, y: 8, app: "gedit", window_id: 3 },
    );
    expect(fitted.missing).toEqual(["pid"]);
    expect(fitted.args).toEqual({ x: 4, y: 8, window_id: 3 });
    const fake = new FakeBoat();
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const inner = fake.desktop.bind(fake);
    fake.desktop = async (sandboxId, tool, args) => {
      seen.push({ tool, args });
      if (tool === "tools/list") {
        return {
          text: "[]",
          tree: "",
          schemas: [{ name: "click", required: ["pid", "x", "y"], properties: ["pid", "x", "y"] }],
        };
      }
      return inner(sandboxId, tool, args);
    };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-schema-"));
    const db = new LincoDb(path.join(dataDir, "linco.sqlite"));
    const user = db.createUser("Ada", dataDir);
    const manager = new BoatSandboxManager({
      client: fake,
      db,
      machineType: "small",
      ttlSeconds: 60,
      idleStopMs: 60_000,
      maxSeconds: 1200,
    });
    await expect(manager.desktop(user.id, "task", "click", { x: 1, y: 2, noise: true })).rejects.toThrow(/missing pid/);
    await manager.desktop(user.id, "task", "click", { pid: 9, x: 1, y: 2, noise: true });
    const click = seen.findLast((call) => call.tool === "click");
    expect(click?.args).toEqual({ pid: 9, x: 1, y: 2 });
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("treats a driver isError result as a failed call", () => {
    const encoded = mcpCommand("click", { x: 1 }).split(" ")[2] ?? "";
    const script = Buffer.from(encoded, "base64").toString("utf8");
    expect(script).toContain('result.isError === true');
    expect(script).toContain('part.type === "error"');
    expect(script).toContain("schemas");
    expect(script).not.toContain("Content-Length: ");
  });

  it("does not call a page open successful until the title is present", async () => {
    expect(judge("ERR_CONNECTION_REFUSED", /Example Domain/i, "https://example.com")).toBe("connection");
    expect(judge("Chrome New Tab", /Example Domain/i, "https://example.com")).toBe("not-loaded");
    expect(judge("gedit", /Example Domain/i, "https://example.com")).toBe("wrong-window");
    expect(judge("title Example Domain", /Example Domain/i, "https://example.com")).toBe("ok");
    expect(readWindows('[xid=25165827] pid=Some(17135) "New Tab - Chromium" 945x920+10+50')).toEqual([
      { windowId: 25165827, pid: 17135, title: "New Tab - Chromium", width: 945, height: 920, x: 10, y: 50 },
    ]);
    const opened = await openVerifiedPage(driverFrom((tool, nth) => {
      if (tool === "launch_app") return json({ pid: 9, windows: [{ window_id: 3, title: "Chrome" }] });
      if (tool === "get_browser_state" && nth === 1) return json({ title: "Chrome", target_id: "target-1", tab_id: "tab-1" });
      if (tool === "get_browser_state") return text("title Example Domain");
      return text("ok");
    }), "https://example.com", /Example Domain/i);
    expect(opened.ok).toBe(true);
    expect(opened.calls).toContain("browser_navigate");
    const browser = desktopTools({
      desktop: {
        acceptsImages: true,
        schema: () => undefined,
        call: async (tool) => {
          if (tool === "launch_app") return json({ pid: 9, windows: [{ window_id: 3, title: "Chrome" }] });
          return text("Chrome New Tab");
        },
      },
    } as ToolHost).find((tool) => tool.name === "desktop_browser");
    const failed = await browser?.execute("1", { url: "https://example.com" }, new AbortController().signal);
    expect(JSON.stringify(failed)).toContain("not-loaded");
    expect(JSON.stringify(failed)).toContain('"isError":true');
  });

  it("types through click and type_text, and checks the painted png", async () => {
    const typed = await typeIntoEditor(driverFrom((tool) => {
      if (tool === "launch_app") return json({ pid: 4, windows: [{ window_id: 6, title: "gedit" }] });
      if (tool === "get_window_state") return json({ x: 10, y: 20, width: 400, height: 300, title: "gedit" });
      return text("ok");
    }, (name) => (name === "hotkey" ? { name, required: [], properties: ["key", "pid", "window_id"] } : undefined)), "/home/user/linco/proof/typed.txt", "PHASE10-TYPE");
    expect(typed.ok).toBe(true);
    expect(typed.calls).toContain("click");
    expect(typed.calls).toContain("type_text");
    expect(typed.calls).toContain("hotkey");
    const png = labelPng("S4K9", 24);
    const info = inspectPng(png);
    expect(info.png).toBe(true);
    expect(info.decoded).toBe(true);
    expect(info.dark).toBeGreaterThan(20);
    expect(png.toString("latin1")).not.toContain("S4K9");
    const wide = labelPng("AB2C", 48);
    const cropped = cropForReading(wide);
    const croppedInfo = inspectPng(cropped);
    expect(croppedInfo.decoded).toBe(true);
    expect(croppedInfo.dark).toBeGreaterThan(20);
    expect(cropped.toString("latin1")).not.toContain("AB2C");
    const shot = await captureViewer(driverFrom((tool) => {
      if (tool === "list_windows") return json([{ title: "shot.png", pid: 4, window_id: 8 }]);
      if (tool === "get_window_state") return { ...text("eog shot.png"), image: { data: png.toString("base64"), mimeType: "image/png" } };
      return text("ok");
    }), "shot.png");
    expect(shot.ok).toBe(true);
    expect(shot.dark).toBeGreaterThan(20);
    const blank = await captureViewer(driverFrom((tool) => {
      if (tool === "list_windows") return json([{ title: "shot.png", pid: 4, window_id: 8 }]);
      if (tool === "get_window_state") return { ...text("eog"), image: { data: Buffer.from("hi").toString("base64"), mimeType: "image/png" } };
      return text("ok");
    }), "shot.png");
    expect(blank.ok).toBe(false);
    expect(blank.kind).toBe("unreliable");
    expect(quotedCode("S4K9", "S4K9")).toBe(true);
    expect(quotedCode("7MVL", "S4K9")).toBe(false);
    expect(quotedCode("S4K9 or 7MVL", "S4K9")).toBe(false);
  });
});

function text(value: string): DesktopObservation {
  return { text: value, tree: value };
}

function json(value: unknown): DesktopObservation {
  return text(JSON.stringify(value));
}

function driverFrom(
  reply: (tool: string, nth: number) => DesktopObservation,
  schema: DriverCaller["schema"] = () => undefined,
): DriverCaller {
  const counts = new Map<string, number>();
  return {
    schema,
    async call(tool) {
      const nth = (counts.get(tool) ?? 0) + 1;
      counts.set(tool, nth);
      return reply(tool, nth);
    },
  };
}

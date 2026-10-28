import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BoatSandboxManager } from "../src/boat/manager.js";
import { LincoDb } from "../src/db/database.js";
import { assessShell } from "../src/security/policy.js";
import { desktopTools } from "../src/tools/desktop-tools.js";
import type { ToolHost } from "../src/tools/host.js";
import { FakeBoat } from "./boat-fake.js";

describe("browser stays off", () => {
  it("seals leftover browser state and refuses a later Chrome launch", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-browser-"));
    const db = new LincoDb(path.join(dataDir, "linco.sqlite"));
    const fake = new FakeBoat();
    const manager = new BoatSandboxManager({
      client: fake,
      db,
      machineType: "small",
      ttlSeconds: 600,
      idleStopMs: 60_000,
      maxSeconds: 1200,
      vmBrowser: false,
    });
    const user = db.createUser("Ada", dataDir);
    try {
      await manager.ensure(user.id);
      expect(fake.commands.some((command) => command.includes("killall") && command.includes("browser.sock"))).toBe(true);
      const desktopCalls = fake.desktopCalls.length;
      await expect(manager.desktop(user.id, "task", "launch_app", { name: "google-chrome", app: "google-chrome" })).rejects.toThrow(/private pilot/);
      await expect(manager.desktop(user.id, "task", "browser_navigate", { url: "https://example.com" })).rejects.toThrow(/private pilot/);
      await expect(manager.run(user.id, "google-chrome https://example.com", 5_000)).rejects.toThrow(/private pilot/);
      await expect(manager.run(user.id, "chromium --headless", 5_000)).rejects.toThrow(/private pilot/);
      await expect(manager.run(user.id, "curl http://169.254.169.254/latest", 5_000)).rejects.toThrow(/private pilot/);
      const ran = await manager.run(user.id, "node proof/file.mjs", 5_000);
      expect(ran.exitCode).toBe(0);
      const sent = fake.commands.filter((command) => command.includes("proof/file.mjs"));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("ulimit -H -t 30");
      const sequence = await manager.desktopSequence(user.id, "task", [{ tool: "launch_app", args: { name: "chromium" } }]);
      expect(sequence[0]?.detail).toMatch(/private pilot/);
      expect(fake.desktopCalls).toHaveLength(desktopCalls);
      expect(fake.commands.some((command) => command.includes("google-chrome") && !command.includes("killall"))).toBe(false);
      await manager.stop(user.id);
      await manager.ensure(user.id);
      expect(fake.commands.filter((command) => command.includes("killall"))).toHaveLength(2);
      expect(assessShell("node proof/file.mjs", "/home/user/linco").action).toBe("allow");
      expect(assessShell("google-chrome", "/home/user/linco").action).toBe("deny");
    } finally {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses desktop browser tools before they call the machine", async () => {
    const calls: string[] = [];
    const tools = desktopTools({
      browserControl: false,
      desktop: {
        acceptsImages: false,
        call: async (tool) => {
          calls.push(tool);
          return { text: "window Chrome", tree: "window Chrome" };
        },
        sequence: async (steps) => {
          calls.push(...steps.map((step) => step.tool));
          return [];
        },
      },
    } as ToolHost);
    const browser = tools.find((tool) => tool.name === "desktop_browser");
    const window = tools.find((tool) => tool.name === "desktop_window");
    const batch = tools.find((tool) => tool.name === "desktop_batch");
    const editor = tools.find((tool) => tool.name === "desktop_window");
    const browserResult = await browser?.execute("1", { url: "https://example.com" }, new AbortController().signal);
    const windowResult = await window?.execute("2", { app: "Google Chrome" }, new AbortController().signal);
    const batchResult = await batch?.execute("3", { steps: [{ tool: "launch_app", text: "chrome" }] }, new AbortController().signal);
    const editorResult = await editor?.execute("4", { app: "gedit" }, new AbortController().signal);
    expect(JSON.stringify(browserResult)).toContain("private pilot");
    expect(JSON.stringify(windowResult)).toContain("private pilot");
    expect(JSON.stringify(batchResult)).toContain("private pilot");
    expect(JSON.stringify(editorResult)).not.toContain("private pilot");
    expect(calls).toEqual(["launch_app"]);
  });
});

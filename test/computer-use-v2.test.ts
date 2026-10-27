import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BoatSandboxManager } from "../src/boat/manager.js";
import { vmBrowserInstallCommand, vmBrowserPrepareCommand, vmBrowserScript, vmBrowserServeCommand } from "../src/boat/vm-browser.js";
import { LincoDb } from "../src/db/database.js";
import { assess } from "../src/security/policy.js";
import type { ToolHost } from "../src/tools/host.js";
import { toolsForPrompt } from "../src/tools/toolset.js";
import { FakeBoat } from "./boat-fake.js";

describe("boat vm browser", () => {
  it("keeps the Chrome profile inside the VM and off the host", () => {
    const script = vmBrowserScript();
    expect(script).toContain("playwright-core");
    expect(script).toContain("connectOverCDP");
    expect(script).toContain("/home/user/linco/.linco/chrome-profile");
    expect(script).toContain("127.0.0.1");
    expect(script).not.toContain("--headless");
    expect(script).toContain("--remote-allow-origins=http://127.0.0.1:9333");
    expect(script).not.toContain("--remote-allow-origins=*");
    expect(script).toContain("Accessibility.getFullAXTree");
    expect(script).toContain("that snapshot is stale");
    expect(script).not.toContain("/Users");
    const checked = spawnSync(process.execPath, ["--check", path.resolve("src/boat/vm-browser.mjs")], { encoding: "utf8" });
    expect(checked.status).toBe(0);
    expect(vmBrowserInstallCommand()).toContain("playwright-core@1.64.1");
    expect(vmBrowserPrepareCommand()).toContain("/home/user/linco/.linco/vm-browser.mjs");
    expect(vmBrowserServeCommand()).not.toContain("&;");
    expect(vmBrowserServeCommand()).toContain("serve.sh");
  });

  it("navigates through a VM command and refuses a metadata address before any command", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-vm-browser-"));
    const db = new LincoDb(path.join(root, "linco.sqlite"));
    const fake = new FakeBoat();
    const manager = new BoatSandboxManager({
      client: fake,
      db,
      machineType: "small",
      ttlSeconds: 600,
      idleStopMs: 60_000,
      maxSeconds: 1200,
      readyTimeoutMs: 2_000,
      lookup: async () => [{ address: "93.184.216.34" }],
    });
    try {
      await expect(manager.browserAct("missing", "task", { op: "goto", url: "http://169.254.169.254/latest" })).rejects.toThrow(/blocked/);
      expect(fake.commands).toHaveLength(0);
      const user = db.createUser("Ada", root);
      const page = await manager.browserAct(user.id, "task", { op: "goto", url: "https://example.com" });
      expect(page.title).toBe("Example Domain");
      expect(page.engine).toBe("playwright");
      expect(fake.commands.some((command) => command.includes("vm-browser.mjs call"))).toBe(true);
      expect(fake.commands.some((command) => command.includes("/Users"))).toBe(false);
      expect(fake.commands.some((command) => command.includes("--headless"))).toBe(false);
      fake.commandDelayMs = 80;
      const held = manager.browserAct(user.id, "hold-a", { op: "hold" });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const second = await manager.desktop(user.id, "hold-b", "get_desktop_state", {}).then(() => "acquired", (error: Error) => error.message);
      await held;
      expect(second).toMatch(/desktop is in use/);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("asks for approval and does not add the host Playwright tools on a Boat session", () => {
    expect(assess("vm_browser_goto", { url: "https://example.com" }, "/tmp/work").action).toBe("approve");
    expect(assess("vm_browser_fill", { url: "https://example.com", name: "custname", text: "a" }, "/tmp/work").action).toBe("approve");
    expect(assess("vm_browser_read", {}, "/tmp/work").action).toBe("allow");
    const names = toolsForPrompt({
      desktop: { acceptsImages: false, call: async () => ({ text: "", tree: "" }) },
      vmBrowser: { act: async () => ({ ok: true, engine: "playwright", op: "read" }) },
      systemPrompt: "linco-toolset: v4-plan",
    } as ToolHost, "linco-toolset: v4-plan\nlinco-computer: boat").map((tool) => tool.name);
    expect(names).toContain("vm_browser_goto");
    expect(names).not.toContain("browser_open");
  });
});

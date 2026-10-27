import { describe, expect, it } from "vitest";
import { assertSnapshotRef, directOpenIntent, elementFromNode, navigationMatches, takeoverRequired } from "../src/boat/ax-snapshot.js";
import { BoatSandboxManager } from "../src/boat/manager.js";
import { routeExecution } from "../src/agent/route.js";
import { LincoDb } from "../src/db/database.js";
import { assess } from "../src/security/policy.js";
import { serperSearch } from "../src/tools/web-research-tools.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeBoat } from "./boat-fake.js";

describe("accessibility refs", () => {
  it("names a backend node and drops the field text", () => {
    const element = elementFromNode({ role: "textbox", name: "Customer", backendNodeId: 42, valueLength: 8 });
    expect(element).toEqual({ ref: "b42", role: "textbox", name: "Customer", disabled: false, filled: true });
    expect(JSON.stringify(element)).not.toContain("secret");
  });

  it("rejects a ref from an older snapshot", () => {
    const current = { snapshotId: 2, targetId: "tab", refs: ["b9"] };
    expect(() => assertSnapshotRef(current, { snapshotId: 1, ref: "b9" })).toThrow(/stale/);
    expect(() => assertSnapshotRef(current, { snapshotId: 2, targetId: "other", ref: "b9" })).toThrow(/stale/);
    expect(() => assertSnapshotRef(current, { snapshotId: 2, ref: "b9" })).not.toThrow();
  });

  it("asks for a person on a password or captcha page", () => {
    expect(takeoverRequired(["Password"])).toBe(true);
    expect(takeoverRequired(["Customer name"])).toBe(false);
  });

  it("accepts the same page and refuses a private or cross-origin hop", () => {
    expect(navigationMatches("https://example.com", "https://example.com/")).toBe("exact");
    expect(navigationMatches("https://example.com", "https://example.com/iana")).toBe("same-origin");
    expect(navigationMatches("http://example.com", "https://example.com/")).toBe("same-origin");
    expect(navigationMatches("https://example.com", "https://iana.org/")).toBe("redirect");
    expect(navigationMatches("https://example.com", "http://169.254.169.254/")).toBe("blocked");
  });

  it("recognises a one-step open and leaves a multi-step request to the agent", () => {
    expect(directOpenIntent("aç https://example.com")?.url).toBe("https://example.com/");
    expect(directOpenIntent("aç https://example.com ve forma tıkla")).toBeNull();
  });
});

describe("execution route", () => {
  it("picks the tool profile before the model does", () => {
    expect(routeExecution("İstanbul'u webden araştır").profile).toBe("search");
    expect(routeExecution("aç https://example.com").profile).toBe("browser");
    expect(routeExecution("formu doldur ve gönder").profile).toBe("browser");
    expect(routeExecution("nano penceresine yaz").profile).toBe("desktop");
    expect(routeExecution("kodu yaz ve terminalde çalıştır").profile).toBe("code");
    expect(routeExecution("tarayıcı kullanma, yalnızca api").profile).toBe("search");
    expect(routeExecution("merhaba").profile).toBe("agent");
  });

  it("stops a desktop sequence at the first driver error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-batch-"));
    const db = new LincoDb(path.join(root, "linco.sqlite"));
    const fake = new FakeBoat();
    fake.failDesktopTool = "type_text";
    const manager = new BoatSandboxManager({ client: fake, db, machineType: "small", ttlSeconds: 600, idleStopMs: 60_000, maxSeconds: 600 });
    const user = db.createUser("Batch", root);
    try {
      const steps = await manager.desktopSequence(user.id, "task", [
        { tool: "click", args: { x: 1, y: 1 } },
        { tool: "type_text", args: { text: "PHASE103" } },
        { tool: "press_key", args: { key: "Return" } },
      ]);
      expect(steps.map((step) => step.tool)).toEqual(["click", "type_text"]);
      expect(steps[1]?.ok).toBe(false);
      expect(fake.desktopCalls.some((call) => call.tool === "press_key")).toBe(false);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses web search without a key and approves a ref click", async () => {
    await expect(serperSearch("linco", undefined)).rejects.toThrow(/SERPER_API_KEY is unset/);
    expect(assess("browser_navigate", { url: "https://example.com" }, "/tmp/work").action).toBe("approve");
    expect(assess("browser_click", { ref: "b1", snapshotId: 1 }, "/tmp/work").action).toBe("allow");
    expect(assess("browser_snapshot", {}, "/tmp/work").action).toBe("allow");
    expect(assess("desktop_batch", { steps: [] }, "/tmp/work").action).toBe("approve");
  });
});

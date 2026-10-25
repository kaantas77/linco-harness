import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBoatClient } from "../src/boat/client.js";
import { BoatSandboxManager } from "../src/boat/manager.js";
import { LincoDb } from "../src/db/database.js";

const live = process.env.LINCO_BOAT_LIVE === "1" && Boolean(process.env.BOAT_API_KEY);

describe.skipIf(!live)("boat live", () => {
  it("creates a sandbox, keeps a home file, and deletes it", async () => {
    const key = process.env.BOAT_API_KEY;
    if (!key) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "linco-boat-live-"));
    const db = new LincoDb(path.join(root, "linco.sqlite"));
    const client = createBoatClient({ apiKey: key, basePath: process.env.BOAT_API_BASE });
    const manager = new BoatSandboxManager({
      client,
      db,
      machineType: "small",
      ttlSeconds: 600,
      idleStopMs: 60 * 60_000,
      maxSeconds: 7_200,
      readyTimeoutMs: 180_000,
    });
    const user = db.createUser("Live", root);
    let sandboxId = "";
    try {
      const ready = await manager.ensure(user.id);
      sandboxId = ready.sandboxId ?? "";
      expect(sandboxId).toBeTruthy();
      await manager.write(user.id, "note.txt", "kept");
      await manager.stop(user.id);
      expect((await manager.read(user.id, "note.txt")).text).toBe("kept");
      const state = await manager.desktop(user.id, "live-task", "get_desktop_state", {});
      expect(state.tree.length).toBeGreaterThan(0);
      const page = await manager.desktop(user.id, "live-task", "get_browser_state", {});
      expect(page.text.length).toBeGreaterThan(0);
    } finally {
      if (sandboxId) await client.delete(sandboxId).catch(() => undefined);
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
});

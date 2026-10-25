import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderBoatLiveMarkdown, runBoatLive } from "../src/boat/live-check.js";

const live = process.env.LINCO_BOAT_LIVE === "1" && Boolean(process.env.BOAT_API_KEY) && Boolean(process.env.DEEPSEEK_API_KEY);

describe.skipIf(!live)("boat live validation", () => {
  it("runs capped natural-language tasks on one Boat computer", async () => {
    const report = await runBoatLive({
      boatApiKey: process.env.BOAT_API_KEY,
      deepseekApiKey: process.env.DEEPSEEK_API_KEY,
      boatBaseUrl: process.env.BOAT_API_BASE,
    });
    const directory = path.resolve("reports");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "boat-live.json"), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(directory, "boat-live.md"), renderBoatLiveMarkdown(report));
    expect(report.liveExecuted).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/sk-|boat_[A-Za-z0-9_-]{8,}/);
    expect(report.deleted).toBe(true);
  }, 1_500_000);
});

import { describe, expect, it } from "vitest";
import { runReleaseCandidate } from "../src/boat/release-candidate.js";

const live = process.env.LINCO_BOAT_LIVE === "1" && Boolean(process.env.BOAT_API_KEY) && Boolean(process.env.DEEPSEEK_API_KEY);

describe.skipIf(!live)("release candidate live", () => {
  it("checks CDP refs on one Boat computer and deletes it", async () => {
    const report = await runReleaseCandidate({
      boatApiKey: process.env.BOAT_API_KEY,
      deepseekApiKey: process.env.DEEPSEEK_API_KEY,
      boatBaseUrl: process.env.BOAT_API_BASE,
      reportDir: "reports",
    });
    expect(report.liveExecuted).toBe(true);
    expect(report.deleted).toBe(true);
    expect(report.performanceClaim).toBe("none");
    expect(report.publicReady).toBe(false);
    expect(report.startedFrom).toBe("0406add");
    expect(JSON.stringify(report)).not.toMatch(/sk-[A-Za-z0-9]{10,}|boat_[A-Za-z0-9_-]{8,}/);
  }, 1_200_000);
});

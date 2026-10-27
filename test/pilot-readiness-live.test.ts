import { describe, expect, it } from "vitest";
import { runPilotReadiness } from "../src/boat/pilot-readiness.js";

const live = process.env.LINCO_BOAT_LIVE === "1" && Boolean(process.env.BOAT_API_KEY) && Boolean(process.env.DEEPSEEK_API_KEY);

describe.skipIf(!live)("pilot readiness live", () => {
  it("measures the file channel and desktop saves, then deletes the sandbox", async () => {
    const report = await runPilotReadiness({
      boatApiKey: process.env.BOAT_API_KEY,
      deepseekApiKey: process.env.DEEPSEEK_API_KEY,
      boatBaseUrl: process.env.BOAT_API_BASE,
      reportDir: "reports",
    });
    expect(report.liveExecuted).toBe(true);
    expect(report.deleted).toBe(true);
    expect(report.performanceClaim).toBe("none");
    expect(report.publicReady).toBe(false);
    expect(report.startedFrom).toBe("162b4f9");
    expect(report.channel.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(/sk-[A-Za-z0-9]{10,}|boat_[A-Za-z0-9_-]{8,}/);
  }, 1_200_000);
});

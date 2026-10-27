import { describe, expect, it } from "vitest";
import { runAgentReliability } from "../src/boat/agent-reliability.js";

const live = process.env.LINCO_BOAT_LIVE === "1" && Boolean(process.env.BOAT_API_KEY) && Boolean(process.env.DEEPSEEK_API_KEY);

describe.skipIf(!live)("agent reliability live", () => {
  it("verifies actions on a Boat VM and deletes the sandbox", async () => {
    const report = await runAgentReliability({
      boatApiKey: process.env.BOAT_API_KEY,
      deepseekApiKey: process.env.DEEPSEEK_API_KEY,
      boatBaseUrl: process.env.BOAT_API_BASE,
      reportDir: "reports",
    });
    expect(report.liveExecuted).toBe(true);
    expect(report.deleted).toBe(true);
    expect(report.publicReady).toBe(false);
    expect(report.startedFrom).toBe("8683678");
    expect(JSON.stringify(report)).not.toMatch(/sk-[A-Za-z0-9]{10,}|boat_[A-Za-z0-9_-]{8,}/);
  }, 1_200_000);
});

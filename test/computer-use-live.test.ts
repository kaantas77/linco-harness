import { describe, expect, it } from "vitest";
import { runComputerUse } from "../src/boat/computer-use.js";

const live = process.env.LINCO_BOAT_LIVE === "1" && Boolean(process.env.BOAT_API_KEY) && Boolean(process.env.DEEPSEEK_API_KEY);

describe.skipIf(!live)("computer use live", () => {
  it("retries the three Boat desktop tasks under the existing caps", async () => {
    const report = await runComputerUse({
      boatApiKey: process.env.BOAT_API_KEY,
      deepseekApiKey: process.env.DEEPSEEK_API_KEY,
      boatBaseUrl: process.env.BOAT_API_BASE,
      reportDir: "reports",
    });
    expect(report.liveExecuted).toBe(true);
    expect(report.deleted).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/sk-[A-Za-z0-9]{10,}|boat_[A-Za-z0-9_-]{8,}/);
    expect(report.performanceClaim).toBe("none");
  }, 1_200_000);
});

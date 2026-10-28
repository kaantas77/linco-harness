import { describe, expect, it } from "vitest";
import { runActionDiagnosis } from "../src/boat/action-diagnosis.js";

const live = process.env.LINCO_BOAT_LIVE === "1" && Boolean(process.env.BOAT_API_KEY) && Boolean(process.env.DEEPSEEK_API_KEY);

describe.skipIf(!live)("action diagnosis live", () => {
  it("compares a fresh session with the same session for desktop and code", async () => {
    const report = await runActionDiagnosis({
      boatApiKey: process.env.BOAT_API_KEY,
      deepseekApiKey: process.env.DEEPSEEK_API_KEY,
      boatBaseUrl: process.env.BOAT_API_BASE,
      reportDir: "reports",
    });
    expect(report.deleted).toBe(true);
    expect(report.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(/sk-[A-Za-z0-9]{10,}|boat_[A-Za-z0-9_-]{8,}/);
  }, 900_000);
});

import { describe, expect, it } from "vitest";
import { runActionExecution } from "../src/boat/action-execution.js";

const live = process.env.LINCO_BOAT_LIVE === "1" && Boolean(process.env.BOAT_API_KEY) && Boolean(process.env.DEEPSEEK_API_KEY);
const only = process.env.LINCO_ACTION_ONLY?.split(",").filter(Boolean) as Array<"desktop" | "code" | "desktop-phrase" | "code-phrase"> | undefined;

describe.skipIf(!live)("action execution live", () => {
  it("runs controlled tools and natural-language tasks in fresh sessions", async () => {
    const report = await runActionExecution({
      boatApiKey: process.env.BOAT_API_KEY,
      deepseekApiKey: process.env.DEEPSEEK_API_KEY,
      boatBaseUrl: process.env.BOAT_API_BASE,
      reportDir: "reports",
      only,
    });
    expect(report.deleted).toBe(true);
    const controlled = report.rows.filter((row) => row.mode === "controlled");
    expect(controlled).toHaveLength(2);
    expect(controlled.every((row) => row.ok)).toBe(true);
    expect(report.rows.some((row) => row.mode === "language")).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/sk-[A-Za-z0-9]{10,}|boat_[A-Za-z0-9_-]{8,}/);
  }, 1_000_000);
});

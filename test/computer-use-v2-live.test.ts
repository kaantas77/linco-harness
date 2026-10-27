import { describe, expect, it } from "vitest";
import { runComputerUseV2 } from "../src/boat/computer-use-v2.js";

const live = process.env.LINCO_BOAT_LIVE === "1" && Boolean(process.env.BOAT_API_KEY) && Boolean(process.env.DEEPSEEK_API_KEY);

describe.skipIf(!live)("boat computer use v2 live", () => {
  it("records the VM browser and vision paths, then deletes the sandbox", async () => {
    const report = await runComputerUseV2({
      boatApiKey: process.env.BOAT_API_KEY,
      deepseekApiKey: process.env.DEEPSEEK_API_KEY,
      boatBaseUrl: process.env.BOAT_API_BASE,
      reportDir: "reports",
    });
    expect(report.liveExecuted).toBe(true);
    expect(report.deleted).toBe(true);
    expect(report.performanceClaim).toBe("none");
    expect(report.startedFrom).toBe("8712a8f");
    expect(report.controlled.map((item) => item.name)).toEqual(expect.arrayContaining(["example", "form", "typing", "shared-vm"]));
    expect(report.vision.some((item) => item.path === "original-high")).toBe(true);
    expect(report.vision.some((item) => item.path === "desktop")).toBe(true);
    expect(report.vision.some((item) => item.path === "cua-tool")).toBe(true);
    const packed = JSON.stringify(report);
    expect(packed).not.toMatch(/sk-[A-Za-z0-9]{10,}|boat_[A-Za-z0-9_-]{8,}/);
  }, 1_200_000);
});

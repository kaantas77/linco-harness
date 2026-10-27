import { describe, expect, it } from "vitest";
import { pickEditorWindow } from "../src/boat/desktop-flow.js";
import { classifyDirectFailure, type ChannelStage } from "../src/boat/probe.js";

function stage(partial: Partial<ChannelStage> & Pick<ChannelStage, "stage">): ChannelStage {
  return {
    ok: false,
    apiOk: false,
    httpStatus: null,
    code: "",
    sandboxState: "running",
    detail: "",
    ...partial,
  };
}

describe("desktop file channel", () => {
  it("treats a 400 on a missing file as file absence when cat still answers", () => {
    const found = classifyDirectFailure([
      stage({ stage: "readText", httpStatus: 400, code: "sandbox_direct_failed", detail: "boat api 400 sandbox_direct_failed" }),
      stage({ stage: "cat", ok: false, apiOk: true, detail: "exit 1 cat: No such file or directory" }),
    ]);
    expect(found.source).toBe("file-absent");
  });

  it("treats a 400 beside a successful cat as a file API failure", () => {
    const found = classifyDirectFailure([
      stage({ stage: "readText", httpStatus: 400, code: "sandbox_direct_failed", detail: "boat api 400 sandbox_direct_failed" }),
      stage({ stage: "cat", ok: true, apiOk: true, detail: "exit 0 PHASE104-TYPE-2" }),
    ]);
    expect(found.source).toBe("file-api");
  });

  it("does not choose an older editor window for a new file", () => {
    const before = new Set([10]);
    const windows = [
      { windowId: 10, pid: 4, title: "pilot-1.txt - nano" },
      { windowId: 11, pid: 8, title: "pilot-2.txt - nano" },
    ];
    expect(pickEditorWindow(before, windows, "pilot-2.txt")?.windowId).toBe(11);
    expect(pickEditorWindow(new Set([10, 11]), [windows[0]!], "pilot-2.txt")).toBeUndefined();
  });
});

/** One Boat call, recorded without a retry. `ok` is the check. `apiOk` means the HTTP call itself completed. */
export interface ChannelStage {
  stage: string;
  ok: boolean;
  apiOk: boolean;
  httpStatus: number | null;
  code: string;
  sandboxState: string;
  detail: string;
}

export interface FailureClass {
  source: "file-api" | "command-api" | "file-absent" | "write-api" | "sandbox" | "saved" | "unknown";
  summary: string;
}

/** Decide which layer produced `sandbox_direct_failed`. A missing file is not a command failure. */
export function classifyDirectFailure(stages: readonly ChannelStage[]): FailureClass {
  const read = stages.find((stage) => stage.stage === "readText");
  const cat = stages.find((stage) => stage.stage === "cat");
  const command = stages.find((stage) => stage.stage === "execCommand");
  const write = stages.find((stage) => stage.stage === "writeText");
  const sandbox = stages.find((stage) => stage.stage === "sandbox");
  const direct = (stage: ChannelStage | undefined) => stage?.code === "sandbox_direct_failed";
  if (sandbox && !sandbox.apiOk) return { source: "sandbox", summary: `sandbox state was not read: ${sandbox.detail}` };
  if (direct(read) && cat?.apiOk && /no such file|cannot stat/i.test(cat.detail)) {
    return { source: "file-absent", summary: "readText returned 400 sandbox_direct_failed and cat found no file. The command API answered." };
  }
  if (direct(read) && cat?.ok) {
    return { source: "file-api", summary: "readText returned 400 sandbox_direct_failed while cat printed the file. The file API direct channel failed." };
  }
  if (direct(read) && command && !command.apiOk && direct(command)) {
    return { source: "command-api", summary: "readText and execCommand both returned sandbox_direct_failed." };
  }
  if (direct(write)) return { source: "write-api", summary: "writeText returned sandbox_direct_failed before a desktop save." };
  if (read?.ok && cat?.ok) return { source: "saved", summary: "readText and cat returned the same file." };
  return { source: "unknown", summary: stages.map((stage) => `${stage.stage}:${stage.code || stage.detail}`).join("; ").slice(0, 240) };
}

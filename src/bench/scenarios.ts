import fs from "node:fs";
import path from "node:path";

export interface LiveScenario {
  id: string;
  group: "files" | "multi-step" | "code" | "session";
  prompts: [string, ...string[]];
  /** Ask the model for a short reasoning trace so preservation can be observed. */
  reasoning: boolean;
  prepare?: (workspace: string) => void;
  grade: (workspace: string) => string | undefined;
}

function textFile(workspace: string, relative: string): string {
  const file = path.join(workspace, relative);
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8").trim();
}

export const liveScenarios: LiveScenario[] = [
  {
    id: "session-continue",
    group: "session",
    reasoning: true,
    prompts: [
      "Use the fs_write tool to create turn.txt. The file content must be exactly one. Do not call any other tool. After the tool succeeds, stop.",
      "Use the fs_write tool to create turn-2.txt. The file content must be exactly two. Do not modify turn.txt. After the tool succeeds, stop.",
    ],
    grade: (workspace) => {
      if (textFile(workspace, "turn.txt") !== "one") return "turn.txt was not exactly one";
      if (textFile(workspace, "turn-2.txt") !== "two") return "turn-2.txt was not exactly two";
      return undefined;
    },
  },
  {
    id: "file-write",
    group: "files",
    reasoning: false,
    prompts: [
      "Use the fs_write tool to create hello.txt. The file content must be exactly hello. Do not call any other tool. After the tool succeeds, stop.",
    ],
    grade: (workspace) => (textFile(workspace, "hello.txt") === "hello" ? undefined : "hello.txt was not exactly hello"),
  },
  {
    id: "multi-step",
    group: "multi-step",
    reasoning: false,
    prompts: [
      "Complete these steps with tools, in order. Step 1: fs_write path data/items.txt with content alpha, a newline, then beta. Step 2: fs_read path data/items.txt. Step 3: fs_write path data/count.txt with content 2. Then stop.",
    ],
    grade: (workspace) => {
      if (textFile(workspace, "data/items.txt") !== "alpha\nbeta") return "data/items.txt was not alpha then beta";
      if (textFile(workspace, "data/count.txt") !== "2") return "data/count.txt was not 2";
      return undefined;
    },
  },
  {
    id: "code-run",
    group: "code",
    reasoning: false,
    prompts: [
      'Call code_run one time with this source and then stop: const written = await tools.fs_write({ path: "result.txt", content: "2+2=4" }); return written;',
    ],
    grade: (workspace) => (textFile(workspace, "result.txt") === "2+2=4" ? undefined : "result.txt was not exactly 2+2=4"),
  },
];

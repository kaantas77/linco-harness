import fs from "node:fs";
import path from "node:path";
import type { ToolUse } from "./continuity.js";

export interface ScenarioEvidence {
  workspace: string;
  tools: ToolUse[];
}

export interface LiveScenario {
  id: string;
  group: "files" | "multi-step" | "code" | "session" | "read" | "edit";
  prompts: [string, ...string[]];
  /** Ask the model for a short reasoning trace so preservation can be observed. */
  reasoning: boolean;
  prepare?: (workspace: string) => void;
  grade: (evidence: ScenarioEvidence) => string | undefined;
}

const INBOX = ["note: alpha", "TODO: ship the report", "note: beta"].join("\n");
const CONFIG = "port=8080\nname=linco\n";

function textFile(workspace: string, relative: string): string {
  const file = path.join(workspace, relative);
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8").trim();
}

function argsOf(tool: ToolUse): Record<string, unknown> {
  return tool.arguments && typeof tool.arguments === "object" ? (tool.arguments as Record<string, unknown>) : {};
}

function textArg(tool: ToolUse, key: string): string {
  const value = argsOf(tool)[key];
  return typeof value === "string" ? value : "";
}

function cleanPath(value: string): string {
  return value.trim().replace(/^\.\//, "").replace(/\\/g, "/");
}

function findUse(tools: ToolUse[], name: string, match: (tool: ToolUse) => boolean, from = 0): number {
  for (let index = Math.max(from, 0); index < tools.length; index += 1) {
    const tool = tools[index];
    if (tool && tool.name === name && match(tool)) return index;
  }
  return -1;
}

function wrote(tool: ToolUse, relative: string, content: string): boolean {
  return cleanPath(textArg(tool, "path")) === relative && textArg(tool, "content").trim() === content;
}

function readPath(tool: ToolUse, relative: string): boolean {
  return cleanPath(textArg(tool, "path")) === relative;
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
    grade: ({ workspace, tools }) => {
      if (textFile(workspace, "turn.txt") !== "one") return "turn.txt was not exactly one";
      if (textFile(workspace, "turn-2.txt") !== "two") return "turn-2.txt was not exactly two";
      if (findUse(tools, "fs_write", (tool) => wrote(tool, "turn.txt", "one")) < 0) return "fs_write did not create turn.txt";
      if (findUse(tools, "fs_write", (tool) => wrote(tool, "turn-2.txt", "two")) < 0) return "fs_write did not create turn-2.txt";
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
    grade: ({ workspace, tools }) => {
      if (textFile(workspace, "hello.txt") !== "hello") return "hello.txt was not exactly hello";
      if (findUse(tools, "fs_write", (tool) => wrote(tool, "hello.txt", "hello")) < 0) return "fs_write did not create hello.txt";
      return undefined;
    },
  },
  {
    id: "multi-step",
    group: "multi-step",
    reasoning: false,
    prompts: [
      "Complete these steps with tools, in order. Step 1: fs_write path data/items.txt with content alpha, a newline, then beta. Step 2: fs_read path data/items.txt. Step 3: fs_write path data/count.txt with content equal to the number of lines you read. Then stop. Writing the count without reading the file does not count.",
    ],
    grade: ({ workspace, tools }) => {
      if (textFile(workspace, "data/items.txt") !== "alpha\nbeta") return "data/items.txt was not alpha then beta";
      if (textFile(workspace, "data/count.txt") !== "2") return "data/count.txt was not 2";
      const wroteItems = findUse(tools, "fs_write", (tool) => wrote(tool, "data/items.txt", "alpha\nbeta"));
      const readItems = findUse(tools, "fs_read", (tool) => readPath(tool, "data/items.txt"), wroteItems + 1);
      const wroteCount = findUse(tools, "fs_write", (tool) => wrote(tool, "data/count.txt", "2"), readItems + 1);
      if (wroteItems < 0 || readItems < 0 || wroteCount < 0) return "fs_read of data/items.txt did not happen between the two writes";
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
    grade: ({ workspace, tools }) => {
      if (textFile(workspace, "result.txt") !== "2+2=4") return "result.txt was not exactly 2+2=4";
      const ran = tools.some((tool) => tool.name === "code_run" && textArg(tool, "source").includes("result.txt"));
      if (!ran) return "code_run did not write result.txt";
      return undefined;
    },
  },
  {
    id: "inbox-pick",
    group: "read",
    reasoning: false,
    prepare: (workspace) => fs.writeFileSync(path.join(workspace, "inbox.txt"), `${INBOX}\n`),
    prompts: [
      "Read inbox.txt with fs_read. One line starts with TODO:. Write that entire line, and nothing else, to picked.txt with fs_write. Then stop.",
    ],
    grade: ({ workspace, tools }) => {
      if (textFile(workspace, "picked.txt") !== "TODO: ship the report") return "picked.txt was not the TODO line";
      const read = findUse(tools, "fs_read", (tool) => readPath(tool, "inbox.txt"));
      const write = findUse(tools, "fs_write", (tool) => wrote(tool, "picked.txt", "TODO: ship the report"), read + 1);
      if (read < 0 || write < 0) return "fs_read of inbox.txt did not happen before writing picked.txt";
      return undefined;
    },
  },
  {
    id: "edit-port",
    group: "edit",
    reasoning: false,
    prepare: (workspace) => fs.writeFileSync(path.join(workspace, "config.txt"), CONFIG),
    prompts: [
      "config.txt contains a port setting. Use fs_edit so the unique snippet port=8080 becomes port=9090. Leave the name line unchanged. Then stop.",
    ],
    grade: ({ workspace, tools }) => {
      if (textFile(workspace, "config.txt") !== "port=9090\nname=linco") return "config.txt was not updated";
      const edited = findUse(
        tools,
        "fs_edit",
        (tool) =>
          cleanPath(textArg(tool, "path")) === "config.txt" &&
          textArg(tool, "old").includes("port=8080") &&
          textArg(tool, "new").includes("port=9090"),
      );
      if (edited < 0) return "fs_edit did not change port=8080";
      return undefined;
    },
  },
];

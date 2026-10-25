import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Harness } from "../src/agent/runtime.js";
import { loadConfig } from "../src/config.js";
import { SCRIPT_MODEL, scriptedStream, type ScriptStep } from "../src/llm/scripted.js";
import type { StreamFn } from "@earendil-works/pi-agent-core";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");

export async function withHarness(
  run: (harness: Harness) => Promise<void>,
  options: {
    steps?: ScriptStep[];
    workerCount?: number;
    compactMaxChars?: number;
    compactRequests?: boolean;
    streamFn?: StreamFn;
  } = {},
): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linco-"));
  const harness = new Harness({
    config: loadConfig({
      dataDir,
      skillsDir,
      workerCount: options.workerCount ?? 2,
      schedulerIntervalMs: 60_000,
      compactMaxChars: options.compactMaxChars ?? 180_000,
      compactRequests: options.compactRequests,
      port: 0,
      authMode: "dev",
      manageCredentials: false,
      allowLoopback: true,
      sandbox: "require",
      computer: "local",
    }),
    model: SCRIPT_MODEL,
    streamFn: options.streamFn ?? scriptedStream(options.steps ?? [{ text: "ok" }]),
  });
  harness.start();
  try {
    await run(harness);
  } finally {
    await harness.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

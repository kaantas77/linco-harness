/**
 * One MCP call to the Cua Driver that Boat already starts in the sandbox.
 * The command runs inside the VM and speaks JSON-RPC to `cua-driver mcp --socket`.
 * It does not install another driver.
 */
const MCP_SOURCE = `
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
let payload;
for (const arg of process.argv.slice(1)) {
  try {
    const parsed = JSON.parse(Buffer.from(arg, "base64").toString("utf8"));
    if (parsed && typeof parsed.tool === "string") payload = parsed;
  } catch { /* the script name is not the payload */ }
}
function finish(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
  process.exit(value.ok ? 0 : 1);
}
if (!payload) finish({ ok: false, error: "missing desktop request" });
const bin = existsSync("/opt/ascii/cua-driver/cua-driver") ? "/opt/ascii/cua-driver/cua-driver" : "cua-driver";
const child = spawn(bin, ["mcp", "--socket", "/run/ascii-cua/driver.sock"], { stdio: ["pipe", "pipe", "pipe"] });
let buffer = Buffer.alloc(0);
const waiting = new Map();
let next = 1;
function send(message) {
  child.stdin.write(JSON.stringify(message) + "\\n");
}
function deliver(message) {
  if (message.id === undefined) return;
  const pending = waiting.get(message.id);
  if (pending) pending(message);
}
function take() {
  while (buffer.length) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd >= 0) {
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\\s*(\\d+)/i.exec(header);
      if (!match) return;
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const body = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      deliver(JSON.parse(body));
      continue;
    }
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const line = buffer.subarray(0, newline).toString("utf8").trim();
    buffer = buffer.subarray(newline + 1);
    if (line.startsWith("{")) deliver(JSON.parse(line));
  }
}
let stderr = "";
child.stdout.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); take(); });
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-300); });
child.on("error", (error) => finish({ ok: false, error: "preinstalled cua-driver was not found: " + error.message }));
function ask(method, params) {
  const id = next++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}
const timer = setTimeout(() => finish({ ok: false, error: "boat desktop driver timed out" + (stderr ? ": " + stderr : "") }), 45000);
const started = await ask("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "linco-harness", version: "0.1.0" },
});
if (started.error) finish({ ok: false, error: started.error.message || "mcp initialize failed" });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
if (payload.tool === "tools/list") {
  const listed = await ask("tools/list", {});
  clearTimeout(timer);
  if (listed.error) finish({ ok: false, error: listed.error.message || "mcp list failed" });
  const tools = listed.result && Array.isArray(listed.result.tools) ? listed.result.tools : [];
  const names = tools.map((tool) => tool && tool.name).filter((name) => typeof name === "string");
  finish({ ok: true, text: JSON.stringify(names), tree: names.join("\\n") });
}
const called = await ask("tools/call", { name: payload.tool, arguments: payload.arguments || {} });
clearTimeout(timer);
if (called.error) finish({ ok: false, error: called.error.message || "mcp tool failed" });
const result = called.result || {};
const content = Array.isArray(result.content) ? result.content : [];
const texts = [];
let image;
for (const part of content) {
  if (part && part.type === "text" && typeof part.text === "string") texts.push(part.text);
  const data = part && part.type === "image" ? (part.data || (part.source && part.source.data)) : undefined;
  if (typeof data === "string") image = { data, mimeType: part.mimeType || (part.source && part.source.media_type) || "image/png" };
}
const text = texts.join("\\n") || JSON.stringify(result).slice(0, 8000);
if (image && image.data.length > 1500000) image = undefined;
finish({ ok: true, text, tree: text, image });
`;

/** Names Linco asks the preinstalled driver to call. A live run compares these with tools/list. */
export const ASSUMED_DESKTOP_TOOLS = [
  "get_desktop_state",
  "get_window_state",
  "click",
  "type_text",
  "launch_app",
  "bring_to_front",
  "browser_navigate",
  "get_browser_state",
];

export function mcpCommand(tool: string, args: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ tool, arguments: args })).toString("base64");
  const script = Buffer.from(MCP_SOURCE).toString("base64");
  return `printf %s ${script} | base64 -d | node --input-type=module - ${payload}`;
}

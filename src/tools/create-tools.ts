import type { AgentTool } from "@earendil-works/pi-agent-core";
import { codeRunTool, guardedInvoke } from "./code-mode.js";
import { fileTools } from "./files.js";
import type { ToolHost } from "./host.js";
import { catalogTools, shellTool, webTool } from "./agent-tools.js";

/** Tool order is part of the cached prompt prefix. Do not sort this list. */
export function createTools(host: ToolHost): AgentTool[] {
  const files = fileTools(host);
  const list = files[0];
  const read = files[1];
  const write = files[2];
  const edit = files[3];
  const remove = files[4];
  if (!list || !read || !write || !edit || !remove) throw new Error("file tools are incomplete");
  const shell = shellTool(host);
  const web = webTool(host);
  const catalog = catalogTools(host);
  const code = codeRunTool(host, guardedInvoke(host, [list, read, write, edit, remove, shell, web, ...catalog]));
  return [list, read, write, edit, remove, shell, web, code, ...catalog];
}

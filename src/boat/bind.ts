import type { BrowserProvider, PageSnapshot } from "../tools/browser.js";
import type { ComputerProvider, ExecResult } from "../tools/computer.js";
import type { DesktopBridge } from "../tools/host.js";
import { localFiles, replaceSnippet, type WorkspaceFiles } from "../tools/local-files.js";
import type { BoatSandboxManager } from "./manager.js";
import { REMOTE_WORKSPACE } from "./paths.js";
import type { VmBrowserRequest, VmBrowserResult } from "./vm-browser.js";

export function bindBoat(
  manager: BoatSandboxManager,
  input: { userId: string; taskId: string; acceptsImages: boolean },
): {
  workspacePath: string;
  files: WorkspaceFiles;
  computer: ComputerProvider;
  browser: BrowserProvider;
  desktop: DesktopBridge;
  vmBrowser: { act(request: VmBrowserRequest): Promise<VmBrowserResult> };
} {
  const files: WorkspaceFiles = {
    list: (relativePath) => manager.list(input.userId, relativePath),
    read: (relativePath) => manager.read(input.userId, relativePath),
    write: (relativePath, content) => manager.write(input.userId, relativePath, content),
    remove: (relativePath) => manager.remove(input.userId, relativePath),
    async edit(relativePath, oldText, newText) {
      const current = await manager.read(input.userId, relativePath);
      await manager.write(input.userId, relativePath, replaceSnippet(current.text, oldText, newText));
    },
  };
  const computer: ComputerProvider = {
    id: "boat-sandbox",
    exec(command): Promise<ExecResult> {
      return manager.run(input.userId, command.command, command.timeoutMs, command.signal);
    },
  };
  const browser: BrowserProvider = {
    id: "boat-sandbox",
    fetchPage(url, signal): Promise<PageSnapshot> {
      return manager.fetchPage(input.userId, url, signal);
    },
  };
  const desktop: DesktopBridge = {
    acceptsImages: input.acceptsImages,
    call: (tool, args) => manager.desktop(input.userId, input.taskId, tool, args),
    schema: (name) => manager.schema(name),
    sequence: (steps) => manager.desktopSequence(input.userId, input.taskId, steps),
    editFile: (relativePath, text) => manager.editDesktopFile(input.userId, input.taskId, relativePath, text),
  };
  const vmBrowser = {
    act: (request: VmBrowserRequest) => manager.browserAct(input.userId, input.taskId, request),
  };
  return { workspacePath: REMOTE_WORKSPACE, files, computer, browser, desktop, vmBrowser };
}

export { localFiles };

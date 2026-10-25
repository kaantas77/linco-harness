import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { NavigationBlocked, assertNavigable } from "./navigation-policy.js";
import { clickBackend, fillBackend, formatSemanticSnapshot, readSemantic, selectBackend } from "./semantic.js";

export interface BrowserTarget {
  workspaceRoot: string;
  taskId: string;
  signal: AbortSignal;
  /** Local test pages. Production navigation leaves this off. */
  allowLoopback?: boolean;
}

export interface PageShot {
  snapshotId: number;
  title: string;
  url: string;
  text: string;
}

interface LiveSession {
  taskId: string;
  profile: string;
  lockPath: string;
  allowLoopback: boolean;
  context: BrowserContext;
  page: Page;
  snapshotId: number;
  refs: Map<string, number>;
}

const sessions = new Map<string, LiveSession>();
const closing = new Map<string, Promise<void>>();

export async function openBrowser(target: BrowserTarget, url?: string): Promise<PageShot> {
  const session = await acquire(target);
  if (url) await goto(session, target, url);
  return snapshot(session, target);
}

export async function readBrowser(target: BrowserTarget): Promise<{ url: string; title: string; text: string }> {
  const session = requireSession(target);
  const text = await session.page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  return { url: session.page.url(), title: await session.page.title(), text: text.slice(0, 20_000) };
}

export async function snapshotBrowser(target: BrowserTarget): Promise<PageShot> {
  return snapshot(requireSession(target), target);
}

export async function clickBrowser(
  target: BrowserTarget,
  input: { ref?: string; snapshotId?: number; role?: string; name?: string },
  observe = true,
): Promise<string> {
  const session = requireSession(target);
  if (input.ref) await clickBackend(session.page, backendFor(session, input));
  else {
    const locator = resolveRole(session, input);
    if ((await locator.count()) !== 1) throw new Error("element is not unique");
    await locator.click({ timeout: 5_000 });
  }
  await session.page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
  return afterAction(session, target, observe, "clicked");
}

export async function fillBrowser(
  target: BrowserTarget,
  input: { ref?: string; snapshotId?: number; role?: string; name?: string; text: string },
  observe = true,
): Promise<string> {
  const session = requireSession(target);
  if (input.ref) await fillBackend(session.page, backendFor(session, input), input.text);
  else {
    const locator = resolveRole(session, input);
    if ((await locator.count()) !== 1) throw new Error("element is not unique");
    await locator.fill(input.text, { timeout: 5_000 });
  }
  return afterAction(session, target, observe, "filled");
}

export async function selectBrowser(
  target: BrowserTarget,
  input: { ref?: string; snapshotId?: number; option: string },
  observe = true,
): Promise<string> {
  const session = requireSession(target);
  if (!input.ref) throw new Error("a ref from the latest semantic snapshot is required");
  await selectBackend(session.page, backendFor(session, input), input.option);
  return afterAction(session, target, observe, "selected");
}

export async function pressBrowser(target: BrowserTarget, key: string): Promise<string> {
  const session = requireSession(target);
  await session.page.keyboard.press(key);
  invalidate(session);
  return `pressed ${key}`;
}

export async function scrollBrowser(target: BrowserTarget, direction: "up" | "down"): Promise<string> {
  const session = requireSession(target);
  await session.page.mouse.wheel(0, direction === "up" ? -600 : 600);
  invalidate(session);
  return `scrolled ${direction}`;
}

export async function tabsBrowser(
  target: BrowserTarget,
  input: { action: "list" | "open" | "select" | "close"; url?: string; index?: number },
): Promise<string> {
  const session = requireSession(target);
  if (input.action === "list") {
    const lines = await Promise.all(
      session.context.pages().map(async (page, index) => `${index} ${await page.title()} ${page.url()}`),
    );
    return lines.join("\n");
  }
  if (input.action === "open") {
    if (!input.url) throw new NavigationBlocked("open needs a url");
    const page = await session.context.newPage();
    session.page = page;
    await goto(session, target, input.url);
    invalidate(session);
    return `opened ${page.url()}`;
  }
  const pages = session.context.pages();
  const index = input.index ?? -1;
  const page = pages[index];
  if (!page) throw new Error("tab not found");
  if (input.action === "close") {
    await page.close();
    const rest = session.context.pages();
    const next = rest[rest.length - 1];
    if (!next) throw new Error("last tab closed");
    session.page = next;
    invalidate(session);
    return `closed tab ${index}`;
  }
  await page.bringToFront();
  session.page = page;
  invalidate(session);
  return `selected ${page.url()}`;
}

export async function screenshotBrowser(target: BrowserTarget, file: string): Promise<string> {
  const session = requireSession(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await session.page.screenshot({ path: file, timeout: 5_000 });
  return file;
}

export async function verifyBrowser(
  target: BrowserTarget,
  expected: { urlIncludes?: string; title?: string; role?: string; name?: string },
): Promise<PageShot> {
  const shot = await snapshot(requireSession(target), target);
  if (expected.urlIncludes && !shot.url.includes(expected.urlIncludes)) {
    throw new Error(`url is ${shot.url}`);
  }
  if (expected.title && shot.title !== expected.title) throw new Error(`title is ${shot.title}`);
  if (expected.role && expected.name) {
    const count = await requireSession(target).page.getByRole(expected.role as never, { name: expected.name, exact: true }).count();
    if (count !== 1) throw new Error(`expected one ${expected.role} named ${expected.name}`);
  }
  return shot;
}

export async function closeTaskBrowser(taskId: string): Promise<void> {
  const current = closing.get(taskId);
  const found = [...sessions.entries()].filter((entry) => entry[1].taskId === taskId);
  if (found.length === 0) {
    await current;
    return;
  }
  for (const [profile, session] of found) {
    if (sessions.get(profile) === session) sessions.delete(profile);
  }
  const job = Promise.resolve(current).then(async () => {
    for (const [, session] of found) {
      await session.context?.close().catch(() => undefined);
      releaseLock(session.lockPath, session.taskId);
    }
  });
  closing.set(taskId, job);
  try {
    await job;
  } finally {
    if (closing.get(taskId) === job) closing.delete(taskId);
  }
}

async function acquire(target: BrowserTarget): Promise<LiveSession> {
  if (target.signal.aborted) throw new Error("cancelled");
  const profile = path.join(target.workspaceRoot, ".linco", "browser");
  fs.mkdirSync(profile, { recursive: true });
  const key = fs.realpathSync(profile);
  const existing = sessions.get(key);
  if (existing) {
    if (existing.taskId !== target.taskId || !existing.context) throw new Error("browser profile is in use by another task");
    return existing;
  }
  const lockPath = `${key}.lock`;
  takeLock(lockPath, target.taskId);
  const reserved = {
    taskId: target.taskId,
    profile: key,
    lockPath,
    allowLoopback: target.allowLoopback === true,
    context: undefined as unknown as BrowserContext,
    page: undefined as unknown as Page,
    snapshotId: 0,
    refs: new Map<string, number>(),
  };
  sessions.set(key, reserved);
  try {
    const { chromium } = await import("playwright");
    const context = await chromium.launchPersistentContext(key, {
      headless: true,
      viewport: { width: 1280, height: 720 },
      acceptDownloads: false,
      args: ["--disable-dev-shm-usage"],
    });
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(15_000);
    await context.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (requestUrl === "about:blank" || requestUrl.startsWith("about:blank")) {
        await route.continue();
        return;
      }
      try {
        await assertNavigable(requestUrl, { allowLoopback: reserved.allowLoopback });
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const session: LiveSession = reserved;
    session.context = context;
    session.page = page;
    const onAbort = () => {
      void closeTaskBrowser(target.taskId);
    };
    target.signal.addEventListener("abort", onAbort, { once: true });
    return session;
  } catch (error) {
    sessions.delete(key);
    releaseLock(lockPath, target.taskId);
    throw error;
  }
}

export function requireOpenBrowser(target: BrowserTarget): void {
  requireSession(target);
}

function requireSession(target: BrowserTarget): LiveSession {
  if (target.signal.aborted) throw new Error("cancelled");
  const profile = path.join(target.workspaceRoot, ".linco", "browser");
  const key = fs.realpathSync(profile);
  const session = sessions.get(key);
  if (!session || session.taskId !== target.taskId) throw new Error("browser is not open");
  return session;
}

async function goto(session: LiveSession, target: BrowserTarget, raw: string): Promise<void> {
  const url = await assertNavigable(raw, { allowLoopback: target.allowLoopback === true });
  await session.page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 15_000, signal: target.signal });
  invalidate(session);
}

async function snapshot(session: LiveSession, target: BrowserTarget): Promise<PageShot> {
  if (target.signal.aborted) throw new Error("cancelled");
  const read = await readSemantic(session.page);
  if (read.humanVerification) throw new Error("USER_TAKEOVER_REQUIRED: a password, one-time code, or challenge is on the page");
  session.snapshotId = Math.abs(session.snapshotId) + 1;
  session.refs = new Map(read.elements.map((element) => [element.ref, element.backendNodeId]));
  return {
    snapshotId: session.snapshotId,
    title: read.title,
    url: read.url,
    text: formatSemanticSnapshot(session.snapshotId, read),
  };
}

async function afterAction(session: LiveSession, target: BrowserTarget, observe: boolean, label: string): Promise<string> {
  invalidate(session);
  if (!observe) return label;
  const shot = await snapshot(session, target);
  return shot.text;
}

function backendFor(session: LiveSession, input: { ref?: string; snapshotId?: number }): number {
  if (!input.ref || input.snapshotId !== session.snapshotId || session.snapshotId === 0) {
    throw new Error("that snapshotId is stale; take a new browser_snapshot");
  }
  const backend = session.refs.get(input.ref);
  if (!backend) throw new Error("that snapshotId is stale; take a new browser_snapshot");
  return backend;
}

function resolveRole(session: LiveSession, input: { role?: string; name?: string }) {
  if (!input.role || !input.name) throw new Error("a ref or a role and name is required");
  return session.page.getByRole(input.role as never, { name: input.name, exact: true });
}

function invalidate(session: LiveSession): void {
  session.refs.clear();
  if (session.snapshotId > 0) session.snapshotId = -session.snapshotId;
}

function takeLock(lockPath: string, taskId: string): void {
  const payload = JSON.stringify({ pid: process.pid, taskId });
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, payload);
    fs.closeSync(fd);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    const current = readLock(lockPath);
    if (current?.pid === process.pid && current.taskId === taskId) return;
    if (current?.pid === process.pid) throw new Error("browser profile is in use by another task");
    if (current && pidAlive(current.pid)) throw new Error("browser profile is in use by another task");
    fs.rmSync(lockPath, { force: true });
    takeLock(lockPath, taskId);
  }
}

function releaseLock(lockPath: string, taskId: string): void {
  const current = readLock(lockPath);
  if (current?.pid === process.pid && current.taskId === taskId) fs.rmSync(lockPath, { force: true });
}

function readLock(lockPath: string): { pid: number; taskId: string } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown; taskId?: unknown };
    if (typeof parsed.pid !== "number" || typeof parsed.taskId !== "string") return undefined;
    return { pid: parsed.pid, taskId: parsed.taskId };
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

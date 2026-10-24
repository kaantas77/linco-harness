import { snapshotHostAllowed } from "./navigation-policy.js";
import { jevRun, type BrowserElement, type BrowserSnapshot, type ComputerCall, type JevRunResult } from "./jev-run.js";
import {
  clickBrowser,
  fillBrowser,
  requireOpenBrowser,
  selectBrowser,
  snapshotBrowser,
  type BrowserTarget,
} from "./session.js";

type ElementCheck = { role: string; name: string; filled?: boolean; value?: string; expanded?: boolean; selected?: boolean };
export interface Delegation {
  goal: string;
  expected: {
    url?: string;
    documentUrl?: string;
    title?: string;
    element?: ElementCheck;
    absentElement?: { role: string; name: string };
  };
  inputs?: Array<{ role: string; name: string; value: string }>;
  maxActions?: number;
}

export interface JevDelegationResult {
  status: "done" | "escalate";
  reason: string;
  title: string;
  url: string;
  currentSnapshot: string;
  next: string;
  actions: number;
  typesafeCalls: number;
  typesafeInputTokens: number;
  typesafeOutputTokens: number;
  computerCalls: number;
  elapsedMs: number;
}

const text = (value: unknown, max = 2000): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));

export function parseDelegation(raw: unknown): Delegation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid delegation");
  const value = raw as Record<string, unknown>;
  const expected = value.expected;
  if (
    !exactKeys(value, ["goal", "expected", "inputs", "maxActions"]) ||
    !text(value.goal) ||
    !expected ||
    typeof expected !== "object" ||
    Array.isArray(expected) ||
    !exactKeys(expected as Record<string, unknown>, ["url", "documentUrl", "title", "element", "absentElement"]) ||
    Object.keys(expected).length === 0
  ) {
    throw new Error("a bounded goal and independent verification are required");
  }
  const check = expected as Delegation["expected"];
  if (check.absentElement !== undefined) {
    const absent = check.absentElement as unknown;
    if (!absent || typeof absent !== "object" || Array.isArray(absent)) throw new Error("invalid absent element verification");
    const record = absent as Record<string, unknown>;
    if (!exactKeys(record, ["role", "name"]) || !text(record.role, 60) || !text(record.name, 300)) {
      throw new Error("invalid absent element verification");
    }
  }
  for (const key of ["url", "documentUrl"] as const) {
    const destination = check[key];
    if (destination === undefined) continue;
    if (!text(destination, 2000)) throw new Error("invalid destination");
    const url = new URL(destination);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid destination");
  }
  if (check.title !== undefined && !text(check.title, 300)) throw new Error("invalid title");
  if (check.element !== undefined) {
    const element = check.element as unknown;
    if (!element || typeof element !== "object" || Array.isArray(element)) throw new Error("invalid element verification");
    const record = element as Record<string, unknown>;
    if (
      !exactKeys(record, ["role", "name", "filled", "value", "expanded", "selected"]) ||
      !text(record.role, 60) ||
      !text(record.name, 300) ||
      (["filled", "expanded", "selected"] as const).some((key) => record[key] !== undefined && typeof record[key] !== "boolean") ||
      (record.value !== undefined && !text(record.value, 1000))
    ) {
      throw new Error("invalid element verification");
    }
  }
  if (value.inputs !== undefined) {
    if (!Array.isArray(value.inputs) || value.inputs.length > 12) throw new Error("invalid grounded inputs");
    for (const field of value.inputs) {
      if (!field || typeof field !== "object" || Array.isArray(field)) throw new Error("invalid grounded inputs");
      const record = field as Record<string, unknown>;
      if (
        !exactKeys(record, ["role", "name", "value"]) ||
        !["textbox", "searchbox", "combobox"].includes(String(record.role)) ||
        !text(record.name, 300) ||
        !text(record.value, 1000)
      ) {
        throw new Error("invalid grounded inputs");
      }
    }
  }
  if (value.maxActions !== undefined && (!Number.isInteger(value.maxActions) || Number(value.maxActions) < 1 || Number(value.maxActions) > 8)) {
    throw new Error("invalid action budget");
  }
  return value as unknown as Delegation;
}

const canonical = (url: string, document = false) => {
  const parsed = new URL(url);
  if (document) parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/$/, "") || "/";
  return parsed.href;
};

export function verifies(snapshot: BrowserSnapshot, expected: Delegation["expected"]): boolean {
  if (expected.url && canonical(snapshot.url) !== canonical(expected.url)) return false;
  if (expected.documentUrl && canonical(snapshot.url, true) !== canonical(expected.documentUrl, true)) return false;
  if (expected.title && snapshot.title !== expected.title) return false;
  if (expected.absentElement && snapshot.elements.some((element) => element.role === expected.absentElement?.role && element.name === expected.absentElement?.name)) {
    return false;
  }
  if (expected.element) {
    const wanted = expected.element;
    const matches = snapshot.elements.filter((element) => element.role === wanted.role && element.name === wanted.name && !element.disabled);
    const field = matches[0];
    const value = field?.value ?? (field?.role === "combobox" ? field.visibleText?.split(":").at(-1)?.trim() : undefined);
    if (
      matches.length !== 1 ||
      !field ||
      (["filled", "expanded", "selected"] as const).some((key) => wanted[key] !== undefined && field[key] !== wanted[key]) ||
      (wanted.value !== undefined && value !== wanted.value)
    ) {
      return false;
    }
  }
  return true;
}

interface TaskJev {
  abort: AbortController;
  busy: boolean;
  closed: boolean;
  runs: number;
  calls: number;
  actions: number;
  elapsedMs: number;
  previous: { contract: string; state: string } | null;
}

const tasks = new Map<string, TaskJev>();

export function closeJevTask(taskId: string): void {
  const task = tasks.get(taskId);
  if (!task) return;
  task.closed = true;
  task.abort.abort();
  tasks.delete(taskId);
}

export function jevKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.TYPESAFE_API_KEY?.trim();
  return key ? key : undefined;
}

export async function runDelegatedJev(input: {
  taskId: string;
  raw: unknown;
  key: string;
  target: BrowserTarget;
  fetchImpl?: typeof fetch;
}): Promise<JevDelegationResult> {
  const contract = parseDelegation(input.raw);
  let task = tasks.get(input.taskId);
  if (!task || task.closed) {
    task = { abort: new AbortController(), busy: false, closed: false, runs: 0, calls: 0, actions: 0, elapsedMs: 0, previous: null };
    tasks.set(input.taskId, task);
  }
  const current = task;
  const escalate = (reason: string): JevDelegationResult => ({
    status: "escalate",
    reason,
    title: "",
    url: "",
    currentSnapshot: "",
    next: "Keep the current browser state. Repair or revise the goal before delegating again.",
    actions: 0,
    typesafeCalls: 0,
    typesafeInputTokens: 0,
    typesafeOutputTokens: 0,
    computerCalls: 0,
    elapsedMs: current.elapsedMs,
  });
  if (current.closed) return escalate("task ended");
  if (current.busy) return escalate("delegation already running");
  if (current.runs >= 6 || current.actions >= 24 || current.elapsedMs >= 90_000) return escalate("task delegation budget exhausted");
  current.busy = true;
  let snapshotText = "";
  let fingerprint = "";
  let repeated = false;
  const started = Date.now();
  try {
    current.runs += 1;
    const encoded = JSON.stringify(contract);
    const result = await jevRun({
      goal: contract.goal,
      key: input.key,
      callComputer: computerFor(input.target),
      fieldValues: contract.inputs,
      maxActions: Math.min(contract.maxActions ?? 4, 24 - current.actions),
      acceptAlreadyDone: true,
      expectedUrl: () => false,
      expectedSnapshot: (snapshot) => verifies(snapshot, contract.expected),
      allowedSnapshotUrl: (url) => !repeated && snapshotHostAllowed(url),
      deadlineAt: started + Math.min(30_000, 90_000 - current.elapsedMs),
      signal: AbortSignal.any([current.abort.signal, input.target.signal]),
      fetchImpl: input.fetchImpl,
      onSnapshot: (snapshot, textSnapshot) => {
        snapshotText = textSnapshot.slice(0, 16_000);
        fingerprint = JSON.stringify({
          title: snapshot.title,
          url: snapshot.url,
          elements: snapshot.elements.map(({ ref: _ref, ...rest }) => rest),
        });
        repeated = current.previous?.contract === encoded && current.previous.state === fingerprint;
      },
    });
    current.actions += result.actions;
    current.calls += result.typesafeCalls;
    current.previous = result.status === "escalate" ? { contract: encoded, state: fingerprint } : null;
    if (result.reason === "human or approval boundary") {
      await computerFor(input.target)("request_user_takeover", { summary: "Jev reached a human verification boundary" });
      return finish(current, result, "", "USER_TAKEOVER_REQUIRED: task paused. Stop and wait for the user.", started);
    }
    const reason = repeated ? "unchanged failed delegation; repair or revise the plan" : result.reason;
    const next = repeated
      ? "Keep the current browser state. Repair or revise the goal before delegating again."
      : result.status === "done"
        ? "Verified subgoal complete. Plan the next subgoal."
        : "Take over at the current state. Delegate again after a repair or a revised bounded plan.";
    return finish(current, { ...result, reason }, snapshotText, next, started);
  } finally {
    current.elapsedMs += Date.now() - started;
    current.busy = false;
  }
}

function finish(task: TaskJev, result: JevRunResult, snapshot: string, next: string, started: number): JevDelegationResult {
  return {
    status: result.status,
    reason: result.reason,
    title: result.title,
    url: result.url,
    currentSnapshot: snapshot,
    next,
    actions: result.actions,
    typesafeCalls: result.typesafeCalls,
    typesafeInputTokens: result.typesafeInputTokens,
    typesafeOutputTokens: result.typesafeOutputTokens,
    computerCalls: result.computerCalls,
    elapsedMs: task.elapsedMs + Date.now() - started,
  };
}

function computerFor(target: BrowserTarget): ComputerCall {
  return async (name, args) => {
    try {
      if (name === "browser_snapshot") {
        requireOpenBrowser(target);
        const shot = await snapshotBrowser(target);
        return { text: shot.text, isError: false };
      }
      if (name === "browser_click") {
        const textResult = await clickBrowser(target, { ref: stringArg(args.ref), snapshotId: numberArg(args.snapshotId) }, false);
        return { text: textResult, isError: false };
      }
      if (name === "browser_fill") {
        const textResult = await fillBrowser(
          target,
          { ref: stringArg(args.ref), snapshotId: numberArg(args.snapshotId), text: stringArg(args.text) ?? "" },
          false,
        );
        return { text: textResult, isError: false };
      }
      if (name === "browser_select") {
        const textResult = await selectBrowser(
          target,
          { ref: stringArg(args.ref), snapshotId: numberArg(args.snapshotId), option: stringArg(args.option) ?? "" },
          false,
        );
        return { text: textResult, isError: false };
      }
      if (name === "request_user_takeover") {
        return { text: "USER_TAKEOVER_REQUIRED: task paused. Stop and wait for the user.", isError: true };
      }
      return { text: `unknown computer action ${name}`, isError: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/stale|denied|unauthorized|forbidden|USER_|sensitive|blocked|not unique|not visible|not open|unsupported|ambiguous/i.test(message)) {
        return { text: message, isError: true };
      }
      throw error;
    }
  };
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export type { BrowserElement };

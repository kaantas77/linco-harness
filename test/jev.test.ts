import { describe, expect, it } from "vitest";
import { parseDelegation, verifies } from "../src/browser/jev-delegation.js";
import { jevRun, parseBrowserSnapshot, validateJevAnswer, type BrowserSnapshot } from "../src/browser/jev-run.js";

const home = "Semantic browser snapshot #1 — Wikipedia: https://www.wikipedia.org/\n" +
  "Pass snapshotId=1 with every browser_click/browser_fill.\n" +
  "- [a1] link: English\n- [a2] link: Español\n";
const destination = "Semantic browser snapshot #2 — Wikipedia, the free encyclopedia: https://en.wikipedia.org/\n" +
  "Pass snapshotId=2 with every browser_click/browser_fill.\n- [a3] link: Main page\n";

const chooseEnglish: typeof fetch = async () => Response.json({
  answers: {
    next_action: {
      choice: "CLICK_a1",
      confidence: 1,
      probabilities: { ESCALATE: 0, CLICK_a1: 1, CLICK_a2: 0 },
    },
  },
});

describe("Jev decision loop", () => {
  it("parses only current snapshot refs and rejects duplicate refs", () => {
    expect(parseBrowserSnapshot(home)?.elements.map((element) => element.ref)).toEqual(["a1", "a2"]);
    expect(parseBrowserSnapshot(`${home}- [a1] link: Other\n`)).toBeNull();
  });

  it("rejects a malformed choice distribution", () => {
    expect(() => validateJevAnswer({ choice: "CLICK_a1", confidence: 0.9, probabilities: { CLICK_a1: 0.9 } }, ["CLICK_a1", "ESCALATE"])).toThrow(/distribution/);
  });

  it("clicks the chosen ref and verifies the next snapshot", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await jevRun({
      goal: "Open Wikipedia and click English",
      key: "test-key",
      expectedUrl: (url) => new URL(url).hostname === "en.wikipedia.org",
      callComputer: async (name, args) => {
        calls.push({ name, args });
        if (name === "browser_snapshot") return { text: calls.length === 1 ? home : destination, isError: false };
        return { text: "clicked a1", isError: false };
      },
      fetchImpl: async () => Response.json({
        answers: { next_action: { choice: "CLICK_a1", confidence: 0.92, probabilities: { ESCALATE: 0.03, CLICK_a1: 0.92, CLICK_a2: 0.05 } } },
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    });
    expect(result.status).toBe("done");
    expect(result.typesafeCalls).toBe(1);
    expect(result.actions).toBe(1);
    expect(String(calls[1]?.args._jevActionId)).toMatch(/^\d{13}-[0-9a-f-]{36}$/);
    delete calls[1]!.args._jevActionId;
    expect(calls[1]).toEqual({ name: "browser_click", args: { ref: "a1", snapshotId: 1, label: "English", observe: false } });
  });

  it("stops before a click when Jev is uncertain", async () => {
    const calls: string[] = [];
    const result = await jevRun({
      goal: "Open Wikipedia and click English",
      key: "test-key",
      expectedUrl: () => false,
      callComputer: async (name) => {
        calls.push(name);
        return { text: home, isError: false };
      },
      fetchImpl: async () => Response.json({
        answers: { next_action: { choice: "CLICK_a1", confidence: 0.4, probabilities: { ESCALATE: 0.2, CLICK_a1: 0.6, CLICK_a2: 0.2 } } },
      }),
    });
    expect(result.status).toBe("escalate");
    expect(calls).toEqual(["browser_snapshot"]);
  });

  it("fills a grounded value before the verified click", async () => {
    let filled = false;
    let clicked = false;
    const result = await jevRun({
      goal: "Fill Search query with alpha then click Find",
      key: "test",
      inputValues: ["alpha"],
      expectedUrl: () => false,
      expectedSnapshot: (snapshot) => snapshot.title === "Verified",
      callComputer: async (name, args) => {
        if (name === "browser_fill") {
          expect(args.text).toBe("alpha");
          filled = true;
          return { text: "filled", isError: false };
        }
        if (name === "browser_click") {
          expect(filled).toBe(true);
          clicked = true;
          return { text: "clicked", isError: false };
        }
        const text = clicked
          ? "Semantic browser snapshot #3 — Verified: https://example.com/done\n"
          : `Semantic browser snapshot #${filled ? 2 : 1} — Search: https://example.com/\n- [b1] searchbox: Search query\n- [b2] button: Find\n`;
        return { text, isError: false };
      },
      fetchImpl: async (_url, init) => {
        const choices = Object.keys(JSON.parse(String(init?.body)).questions.next_action.criteria as Record<string, string>);
        const choice = filled ? "CLICK_b2" : "FILL_b1_0";
        return Response.json({ answers: { next_action: { choice, confidence: 1, probabilities: Object.fromEntries(choices.map((key) => [key, key === choice ? 1 : 0])) } } });
      },
    });
    expect(result.status).toBe("done");
    expect(result.actions).toBe(2);
    expect(result.typesafeCalls).toBe(2);
    expect(clicked).toBe(true);
  });

  it("does not call the model when the action budget is zero", async () => {
    const result = await jevRun({
      goal: "click English",
      key: "trial",
      maxActions: 0,
      expectedUrl: () => true,
      callComputer: async () => ({ text: "Semantic browser snapshot #1 — Wikipedia: https://www.wikipedia.org/\n- [b1] link: English", isError: false }),
      fetchImpl: async () => {
        throw new Error("model must not be called");
      },
    });
    expect(result.status).toBe("escalate");
    expect(result.actions).toBe(0);
    expect(result.typesafeCalls).toBe(0);
    expect(result.computerCalls).toBe(1);
  });

  it("retries one lost snapshot and still makes one model call", async () => {
    let reads = 0;
    let clicked = false;
    const result = await jevRun({
      goal: "English",
      key: "test",
      expectedUrl: (url) => url.includes("en.wikipedia"),
      fetchImpl: chooseEnglish,
      callComputer: async (name) => {
        if (name === "browser_snapshot") {
          if (++reads === 1) throw new Error("transport lost");
          return { text: clicked ? destination : home, isError: false };
        }
        clicked = true;
        return { text: "clicked", isError: false };
      },
    });
    expect(result.status).toBe("done");
    expect(result.typesafeCalls).toBe(1);
    expect(result.retries).toEqual({ snapshot: 1, action: 0, recovered: 1 });
  });

  it("does not retry an approval or stale action", async () => {
    for (const blocked of ["USER_APPROVAL_REQUIRED", "The Action Gateway denied this action.", "that snapshotId is stale"]) {
      let actionCalls = 0;
      const result = await jevRun({
        goal: "English",
        key: "test",
        expectedUrl: () => false,
        fetchImpl: chooseEnglish,
        callComputer: async (name) => {
          if (name === "browser_snapshot") return { text: home, isError: false };
          actionCalls += 1;
          return { text: blocked, isError: true };
        },
      });
      expect(actionCalls).toBe(1);
      expect(result.status).toBe("escalate");
      expect(result.retries.action).toBe(0);
    }
  });

  it("selects a native option before continuing", async () => {
    let selected = false;
    let clicked = false;
    const calls: string[] = [];
    const result = await jevRun({
      goal: "Choose Linux then Continue",
      key: "test",
      inputValues: ["Linux"],
      expectedUrl: (url) => url.endsWith("/done"),
      callComputer: async (name, args) => {
        calls.push(name);
        if (name === "browser_select") {
          expect(args.option).toBe("Linux");
          selected = true;
          return { text: "selected", isError: false };
        }
        if (name === "browser_click") {
          expect(selected).toBe(true);
          clicked = true;
          return { text: "clicked", isError: false };
        }
        const text = clicked
          ? "Semantic browser snapshot #3 — Verified: https://example.com/done\n"
          : `Semantic browser snapshot #${selected ? 2 : 1} — Form: https://example.com/\n- [b1] combobox: Operating system\n- [b2] button: Continue\nSelect state [b1]: ${JSON.stringify({ nativeSelect: true, value: selected ? "Linux" : "Choose", options: [{ label: "Choose", disabled: false }, { label: "Linux", disabled: false }] })}`;
        return { text, isError: false };
      },
      fetchImpl: async (_url, init) => {
        const choices = Object.keys(JSON.parse(String(init?.body)).questions.next_action.criteria as Record<string, string>);
        const choice = selected ? "CLICK_b2" : "SELECT_b1_0";
        return Response.json({ answers: { next_action: { choice, confidence: 1, probabilities: Object.fromEntries(choices.map((key) => [key, key === choice ? 1 : 0])) } } });
      },
    });
    expect(result.status).toBe("done");
    expect(result.typesafeCalls).toBe(2);
    expect(calls).toEqual(["browser_snapshot", "browser_select", "browser_snapshot", "browser_click", "browser_snapshot"]);
  });
});

describe("Jev delegation contract", () => {
  it("requires a bounded expected check", () => {
    expect(() => parseDelegation({ goal: "go", expected: {} })).toThrow(/verification/);
    expect(() => parseDelegation({ goal: "go", expected: { title: "Saved" }, extra: true })).toThrow(/verification/);
    const contract = parseDelegation({ goal: "Save the form", expected: { title: "Saved" }, inputs: [{ role: "textbox", name: "Email", value: "ada@example.com" }] });
    expect(contract.maxActions).toBeUndefined();
  });

  it("verifies an exact title and one enabled element", () => {
    const snapshot: BrowserSnapshot = {
      id: 2,
      title: "Saved",
      url: "http://127.0.0.1/done",
      elements: [{ ref: "b1", role: "heading", name: "Saved", disabled: false }],
    };
    expect(verifies(snapshot, { title: "Saved" })).toBe(true);
    expect(verifies(snapshot, { title: "Contact" })).toBe(false);
    expect(verifies(snapshot, { element: { role: "heading", name: "Saved" } })).toBe(true);
  });
});

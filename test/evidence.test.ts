import { describe, expect, it } from "vitest";
import { contractForPrompt, missingEvidence } from "../src/agent/evidence.js";

describe("execution evidence", () => {
  it("leaves a chat request without a contract", () => {
    expect(contractForPrompt("merhaba")).toBeNull();
    expect(contractForPrompt("Save the contact form")).toBeNull();
    expect(contractForPrompt("what is a process")).toBeNull();
    expect(contractForPrompt("Park until the process stops.")).toBeNull();
  });

  it("recognizes desktop and code phrasing in Turkish and English", () => {
    expect(contractForPrompt("On the desktop, type PHASE106-TYPE into proof/note.txt and save")?.kind).toBe("desktop-type");
    expect(contractForPrompt("Masaüstünde proof/note.txt dosyasına PHASE106-TYPE yaz ve kaydet")?.kind).toBe("desktop-type");
    expect(contractForPrompt("Write a node program proof/main.mjs that prints PHASE106-RUN and run the script")?.kind).toBe("code-run");
    expect(contractForPrompt("proof/main.mjs kodunu yaz ve node ile çalıştır. console.log('PHASE106-RUN')")?.kind).toBe("code-run");
  });

  it("does not treat a snapshot as a click", () => {
    const contract = contractForPrompt("example.com sayfasında More information bağlantısına browser_click ile tıkla");
    expect(contract?.kind).toBe("browser-click");
    const gap = missingEvidence(contract!, { tools: [{ name: "browser_snapshot", isError: false }], pageUrl: "https://example.com/" });
    expect(gap?.retry).toBe(true);
    expect(gap?.missing).toMatch(/browser_click/);
  });

  it("fails a click that already ran when the page did not change, without asking for another click", () => {
    const contract = contractForPrompt("More information bağlantısına browser_click ile tıkla https://example.com");
    const gap = missingEvidence(contract!, {
      tools: [{ name: "browser_click", isError: false }],
      pageUrl: "https://example.com/",
    });
    expect(gap?.retry).toBe(false);
  });

  it("accepts a desktop save only when click, type, and the new file agree", () => {
    const contract = contractForPrompt("nano ile proof/nl-105.txt dosyasına PHASE105-TYPE yaz ve kaydet");
    expect(missingEvidence(contract!, {
      tools: [{ name: "desktop_state", isError: false }],
      fileText: "",
    })?.retry).toBe(true);
    expect(missingEvidence(contract!, {
      tools: [{ name: "desktop_click", isError: false }, { name: "desktop_type", isError: false }],
      fileText: "PHASE105-TYPE\n",
    })).toBeNull();
  });

  it("accepts a code run from the structured exit code, stdout, and target file", () => {
    const contract = contractForPrompt("proof/main-105.mjs kodunu yaz ve node ile çalıştır. console.log('PHASE105-RUN')");
    const gap = missingEvidence(contract!, {
      tools: [{ name: "shell_exec", isError: false, args: "command=node proof/main-105.mjs", result: "exit 0 ok" }],
      outputs: ["ok"],
    });
    expect(gap?.retry).toBe(false);
    expect(gap?.missing).toMatch(/code_write_run/);
    const textOnly = missingEvidence(contract!, {
      tools: [
        { name: "shell_exec", isError: true, result: "exit 1 missing" },
        { name: "shell_exec", isError: false, args: "command=node proof/main-105.mjs", result: "exit 0\nPHASE105-RUN\n" },
      ],
    });
    expect(textOnly?.retry).toBe(false);
    const later = missingEvidence(contract!, {
      tools: [
        {
          name: "shell_exec",
          isError: true,
          result: "exit 1\nPHASE105-RUN",
          run: { exitCode: 1, timedOut: false, stdout: "", command: "node proof/main-105.mjs" },
        },
        {
          name: "shell_exec",
          isError: false,
          result: "exit 1 from an older clipped line",
          run: { exitCode: 0, timedOut: false, stdout: "PHASE105-RUN\n", command: "node proof/main-105.mjs" },
        },
      ],
    });
    expect(later).toBeNull();
    expect(missingEvidence(contract!, {
      tools: [{
        name: "code_write_run",
        isError: false,
        result: "exit 1 in the clipped text",
        run: { exitCode: 0, timedOut: false, stdout: "PHASE105-RUN\n", path: "proof/main-105.mjs", command: "node /home/user/linco/proof/main-105.mjs" },
      }],
    })).toBeNull();
  });

  it("rejects an unrelated shell and a failed child", () => {
    const code = contractForPrompt("proof/main-105.mjs kodunu yaz ve node ile çalıştır. console.log('PHASE105-RUN')");
    expect(missingEvidence(code!, {
      tools: [{ name: "shell_exec", isError: false, args: "command=echo PHASE105-RUN", result: "PHASE105-RUN" }],
    })?.missing).toMatch(/code_write_run/);
    expect(missingEvidence(code!, {
      tools: [{
        name: "shell_exec",
        isError: false,
        run: { exitCode: 0, timedOut: false, stdout: "PHASE105-RUN", command: "echo PHASE105-RUN" },
      }],
    })?.missing).toMatch(/code_write_run/);
    expect(missingEvidence(code!, {
      tools: [{
        name: "shell_exec",
        isError: false,
        run: { exitCode: 0, timedOut: true, stdout: "PHASE105-RUN", command: "node proof/main-105.mjs" },
      }],
    })?.retry).toBe(false);
    expect(missingEvidence(code!, {
      tools: [{
        name: "shell_exec",
        isError: false,
        run: { exitCode: 0, timedOut: false, stdout: "PHASE105-RUN\n", command: "node proof/main-105.mjs" },
      }],
      fileError: "No such file or directory",
    })?.uncertain).toBe(false);
    expect(missingEvidence(code!, {
      tools: [{
        name: "code_write_run",
        isError: false,
        run: { exitCode: 0, timedOut: false, stdout: "PHASE105-RUN\n", path: "proof/main-105.mjs", command: "node proof/main-105.mjs" },
      }],
      fileError: "boat api 400 sandbox_direct_failed",
    })?.uncertain).toBe(true);
    const children = contractForPrompt("İki çocuk görev başlat");
    expect(missingEvidence(children!, {
      tools: [{ name: "task_spawn", isError: false }, { name: "task_spawn", isError: false }],
      children: [{ status: "succeeded" }, { status: "failed" }],
    })?.retry).toBe(false);
  });

  it("does not accept a claim that has no tool result", () => {
    const desktop = contractForPrompt("Masaüstünde proof/nl.txt dosyasına PHASE106-TYPE yaz ve kaydet");
    expect(missingEvidence(desktop!, { tools: [], outputs: ["PHASE106-TYPE kaydedildi"] })?.retry).toBe(true);
    const code = contractForPrompt("proof/main-105.mjs kodunu yaz ve node ile çalıştır. console.log('PHASE105-RUN')");
    expect(missingEvidence(code!, { tools: [], outputs: ["PHASE105-RUN"] })?.retry).toBe(true);
    const children = contractForPrompt("İki çocuk görev başlat");
    expect(missingEvidence(children!, {
      tools: [{ name: "task_spawn", isError: false }, { name: "task_spawn", isError: false }],
      children: [{ status: "succeeded" }, { status: "cancelled" }],
    })?.missing).toMatch(/cancelled|failed/);
  });

  it("separates a missing desktop file from a read that cannot be checked", () => {
    const contract = contractForPrompt("Masaüstünde proof/nl.txt dosyasına PHASE106-TYPE yaz ve kaydet");
    const saved = { name: "desktop_edit_file", isError: false, args: "path=proof/nl.txt" };
    expect(missingEvidence(contract!, { tools: [saved], fileError: "No such file or directory" })?.uncertain).toBe(false);
    expect(missingEvidence(contract!, { tools: [saved], fileError: "boat api 400 sandbox_direct_failed" })?.uncertain).toBe(true);
  });
});

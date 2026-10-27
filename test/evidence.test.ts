import { describe, expect, it } from "vitest";
import { contractForPrompt, missingEvidence } from "../src/agent/evidence.js";

describe("execution evidence", () => {
  it("leaves a chat request without a contract", () => {
    expect(contractForPrompt("merhaba")).toBeNull();
    expect(contractForPrompt("Save the contact form")).toBeNull();
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

  it("does not call a code task done when the output lacks the token", () => {
    const contract = contractForPrompt("proof/main-105.mjs kodunu yaz ve node ile çalıştır. console.log('PHASE105-RUN')");
    const gap = missingEvidence(contract!, { tools: [{ name: "shell_exec", isError: false }], outputs: ["ok"] });
    expect(gap?.retry).toBe(false);
  });
});

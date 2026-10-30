import { describe, expect, it } from "vitest";
import { authorizeCommerceAction, type CommerceAction, type CommerceAuthorization } from "../src/commerce/prelaunch.js";

const live: Omit<CommerceAuthorization, "action"> = {
  stage: "live", businessVerified: true, paymentsVerified: true,
  supplierVerified: true, storePoliciesReady: true,
  ownerGoLiveApproved: true, connectedAccountAuthorized: true
};

describe("commerce prelaunch kill switch", () => {
  it("permits only non-mutating drafts and analysis", () => {
    for (const action of ["research_market", "score_products", "draft_product", "draft_creative", "draft_customer_reply", "analyze_metrics", "simulate_checkout"] as CommerceAction[]) {
      expect(authorizeCommerceAction({ stage: "prelaunch", action }).allowed).toBe(true);
    }
  });
  it("blocks all externally mutating actions before company and payments", () => {
    for (const action of ["publish_product", "launch_campaign", "send_customer_message", "capture_payment", "fulfill_order", "issue_refund"] as CommerceAction[]) {
      expect(authorizeCommerceAction({ stage: "prelaunch", action, userApproved: true, connectedAccountAuthorized: true }).allowed).toBe(false);
    }
  });
  it("blocks go-live without verified legal, payment, supplier, policies and owner approval", () => {
    expect(authorizeCommerceAction({ stage: "live", action: "publish_product", connectedAccountAuthorized: true }).allowed).toBe(false);
  });
  it("blocks connected-account writes without valid connector permissions", () => {
    expect(authorizeCommerceAction({ ...live, action: "publish_product", connectedAccountAuthorized: false }).allowed).toBe(false);
  });
  it("rejects missing, negative, non-integer and over-cap advertising spend", () => {
    for (const budget of [undefined, -1, 0, 10.5, 101]) {
      expect(authorizeCommerceAction({ ...live, action: "launch_campaign", userApproved: true, dailyAdCapCents: 100, todayAdSpendCents: 0, proposedAdSpendCents: budget }).allowed).toBe(false);
    }
    expect(authorizeCommerceAction({ ...live, action: "launch_campaign", userApproved: true, dailyAdCapCents: 100, todayAdSpendCents: 45, proposedAdSpendCents: 50 }).allowed).toBe(true);
  });
  it("blocks unapproved money and non-consensual outbound messaging", () => {
    expect(authorizeCommerceAction({ ...live, action: "capture_payment" }).allowed).toBe(false);
    expect(authorizeCommerceAction({ ...live, action: "issue_refund" }).allowed).toBe(false);
    expect(authorizeCommerceAction({ ...live, action: "send_customer_message" }).allowed).toBe(false);
  });
});

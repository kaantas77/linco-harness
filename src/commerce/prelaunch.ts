export type CommerceStage = "prelaunch" | "live";

export type CommerceAction =
  | "research_market" | "score_products" | "draft_product" | "draft_creative"
  | "draft_customer_reply" | "analyze_metrics" | "simulate_checkout"
  | "publish_product" | "launch_campaign" | "send_customer_message"
  | "capture_payment" | "fulfill_order" | "issue_refund";

const SAFE_PRELAUNCH_ACTIONS = new Set<CommerceAction>([
  "research_market", "score_products", "draft_product",
  "draft_creative", "draft_customer_reply", "analyze_metrics",
  "simulate_checkout",
]);

export interface CommerceAuthorization {
  stage: CommerceStage;
  action: CommerceAction;
  businessVerified?: boolean;
  paymentsVerified?: boolean;
  supplierVerified?: boolean;
  storePoliciesReady?: boolean;
  ownerGoLiveApproved?: boolean;
  connectedAccountAuthorized?: boolean;
  userApproved?: boolean;
  marketingConsent?: boolean;
  dailyAdCapCents?: number;
  todayAdSpendCents?: number;
  proposedAdSpendCents?: number;
}

export interface CommerceDecision {
  allowed: boolean;
  reason: string;
}

/**
 * A fail-closed, side-effect-free gate. Integrations must run this check
 * immediately before any account mutation, not only at planning time.
 */
export function authorizeCommerceAction(ctx: CommerceAuthorization): CommerceDecision {
  if (ctx.stage === "prelaunch") {
    return SAFE_PRELAUNCH_ACTIONS.has(ctx.action)
      ? { allowed: true, reason: "Prelaunch research or draft; no external money/customer mutation authorized." }
      : { allowed: false, reason: "PRELAUNCH_LOCK: real sales, ads, outbound messages and account writes disabled." };
  }

  if (!ctx.businessVerified || !ctx.paymentsVerified || !ctx.supplierVerified ||
      !ctx.storePoliciesReady || !ctx.ownerGoLiveApproved) {
    return { allowed: false, reason: "GO_LIVE_GATES_UNMET: verify company, payment, supplier, policies and owner approval." };
  }

  if (SAFE_PRELAUNCH_ACTIONS.has(ctx.action)) {
    return { allowed: true, reason: "Research/draft action." };
  }

  if (!ctx.connectedAccountAuthorized) {
    return { allowed: false, reason: "CONNECTOR_MISSING: authenticated target account required." };
  }

  if (ctx.action === "launch_campaign") {
    const cap = ctx.dailyAdCapCents, spent = ctx.todayAdSpendCents, proposed = ctx.proposedAdSpendCents;
    if (!ctx.userApproved || !Number.isSafeInteger(cap) || !Number.isSafeInteger(spent) ||
        !Number.isSafeInteger(proposed) || cap! <= 0 || spent! < 0 || proposed! <= 0 ||
        spent! + proposed! > cap!) {
      return { allowed: false, reason: "AD_BUDGET_LOCK: approved campaign and positive spend within daily cap required." };
    }
  }

  if (ctx.action === "send_customer_message" && !ctx.marketingConsent) {
    return { allowed: false, reason: "MESSAGE_CONSENT_REQUIRED: no unsolicited outbound marketing." };
  }

  if (ctx.action === "capture_payment" || ctx.action === "issue_refund") {
    if (!ctx.userApproved) {
      return { allowed: false, reason: "MONEY_APPROVAL_REQUIRED: explicit approval required." };
    }
  }

  return { allowed: true, reason: "Live action allowed by this gate; provider permissions and runtime checks still apply." };
}

export const COMMERCE_AGENT_ROLES = [
  "research", "economics", "merchandising", "creative", "support", "operations"
] as const;

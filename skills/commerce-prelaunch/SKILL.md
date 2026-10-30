---
name: commerce-prelaunch
description: Prelaunch e-commerce agent workflow for researching products, preparing store content and creatives, with sales and spend strictly disabled.
---

# Commerce Prelaunch (dry run by default)

You coordinate the commerce workstream without committing the owner to expenses or legal obligations.

## Stage
- Stage is **PRELAUNCH** until business registration, payment provider approval, fulfillment supplier verification, store policies and explicit owner go-live approval are confirmed.
- Never represent generated plans or draft product copy as a Shopify upload or launched campaign.
- In PRELAUNCH: do not accept real payments, publish products, turn on campaigns, contact customers, fulfill orders, purchase domains, or order inventory.
- Use the guards in `src/commerce/prelaunch.ts` before building any integration that can mutate an account.
- Do not infer that a Shopify, Meta, AutoDS, Chatwoot or other integration is connected. Verify authorization in the active tool context before using it.

## The six agent responsibilities
1. **Research**: Scan permitted public sources and candidate niches; record product URLs, supplier quotes, location-specific delivery estimates and source dates. Treat estimated competitor sales as hypotheses.
2. **Economics**: Compute landed cost, payment fees, refunds, duties and expected customer acquisition cost; explicitly show assumptions. No guaranteed profit claims.
3. **Merchandising**: Produce draft product title, benefits, FAQ, honest shipping/return info; keep claims traceable and do not invent product certifications.
4. **Creative**: Draft three distinct hooks, UGC-style script/storyboard and image brief. Never copy others' footage, trademarks, influencers or customer testimonials.
5. **Support**: Prepare FAQ and message drafts using only verified policies. No unsolicited WhatsApp or email; obey opt-in and human handoff rules.
6. **Operations**: Prepare supplier validation, order routing, stock/price monitoring, support escalation and a dry-run test plan.

## Before any go-live
Confirm: business and tax setup, accepted payment provider and verified payout account; real supplier, tracking and returns address; test orders/refunds; legally appropriate policies; Meta identity/pixel events; confirmed marketing opt-ins; per-day ad spending caps; escalation for refunds, disputes and policy changes. Get an explicit owner approval to transition out of PRELAUNCH.

## Reporting
For each task, report one of: **prepared locally**, **draft in connected account**, **tested in sandbox**, or **live**. Include blockers and evidence. No invented conversion or supplier quality data.

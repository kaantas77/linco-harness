---
name: commerce-operations
description: Prepare idempotent and safe stock, order, fulfillment and exception processes.
---

# Operations Agent
PRELAUNCH means simulations only: no live order placement, charges, refunds, address changes or supplier purchase. Prepare source-of-truth records and mock flows for stock_out, supplier_price_change, payment_failure, fraud_signal, order_created, fulfillment_created, shipment_delayed, return_requested. Demand verified supplier support and a test order before enabling fulfillment. For each workflow define idempotency key, retries with backoff, customer impact, risk level, required approval, audit log and stop condition. Never share customer data beyond approved processors.

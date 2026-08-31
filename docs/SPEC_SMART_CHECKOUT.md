# NailIQ Smart Checkout

Status: **Foundation / Preview only**  
Live money: **OFF**  
Providers: Square Terminal, Stripe Terminal, Stripe Tap to Pay

## Outcome

Smart Checkout gives the front desk one NailIQ checkout flow while each salon
chooses exactly one money provider. The operator reviews a server-owned bill,
the customer pays on the salon's paired device, and NailIQ marks the checkout
paid only after reconciling an authoritative provider receipt.

It does not replace Square or Stripe as the payment source of truth, store raw
card data, or treat a browser success animation as proof of payment.

## What this foundation implements

- Canonical service, add-on, discount, tax, tip, and deposit-credit math.
- A provider-neutral Square/Stripe terminal adapter contract.
- Pure request mapping for Square Terminal and Stripe `card_present` flows.
- Durable device, checkout-session, and immutable line-item tables.
- Human approval required before any provider dispatch can be recorded.
- `outcome_unknown` and reconciliation fields for ambiguous responses.
- Request, idempotency, provider-checkout, and provider-payment deduplication.
- Service-only database ACL/RLS; no browser or authenticated-role table access.
- Owner/admin Smart Checkout Lab with no network/provider/payment action.
- Default-OFF per-salon flag plus explicit platform-ON requirement.

## Checkout experience

1. NailIQ rebuilds the cart from server-owned booking and catalog facts.
2. Receptionist reviews services, add-ons, discounts, tax, tip, and deposit.
3. A human explicitly approves the exact amount.
4. NailIQ creates one provider checkout using one idempotency key.
5. Customer taps, inserts, or swipes on the paired provider device.
6. NailIQ reconciles the provider checkout/payment.
7. Only an exact provider payment receipt may produce `paid`.
8. Receipt delivery and booking completion are separate, retryable outcomes.

## Money equation

```text
subtotal = sum(service and add-on lines)
service total = subtotal - discount + tax
deposit credit = min(captured deposit, service total)
amount due = service total + tip - deposit credit
```

An excess historical deposit never silently becomes tip. It requires a
separate refund/review path.

## State model

```text
draft -> ready_for_review -> awaiting_customer -> pending_provider
                                                   |-> paid
                                                   |-> failed
                                                   |-> outcome_unknown -> reconcile same checkout
```

`outcome_unknown` must not redispatch. The system retrieves the existing
provider checkout until it reaches a terminal state or enters human review.

## Provider rules

### Square

- Salon connects its own Square merchant account.
- Device is paired as a Square Terminal device and belongs to that salon.
- NailIQ submits Terminal checkout requests with an idempotency key.
- Square's payment receipt is authoritative.

### Stripe

- Salon connects its own Stripe account.
- Terminal readers or Tap to Pay are registered under that connected account.
- NailIQ creates `card_present` PaymentIntents in the salon account context.
- Stripe's PaymentIntent/Charge receipt is authoritative.

No salon can mix provider accounts or devices within one checkout session.

## Rollout gates

Live dispatch remains unavailable until all gates pass for one pilot salon:

- provider selected and connected;
- KYC/payouts ready;
- webhook signature and account routing proven;
- paired device proven online;
- sandbox/provider test matrix passed;
- ambiguous-response reconciliation passed;
- refund/cancel/partial-payment behavior passed;
- per-salon flag ON;
- platform flag explicitly ON;
- dispatch kill switch ON.

## Evidence classes

| Capability | Evidence after this PR |
| --- | --- |
| Quote math and readiness rules | Local automated tests |
| Approval/receipt/dedupe DB constraints | Local SQL boundary tests; QA after migration |
| Owner/admin simulator | Preview browser test |
| Square Terminal request | Pure payload test only |
| Stripe Terminal request | Pure payload test only |
| Real terminal collection | NOT_PROVEN |
| Webhook reconciliation | NOT_IMPLEMENTED in this foundation |
| Refund/partial tender | NOT_IMPLEMENTED in this foundation |
| Production money | OFF / NOT_PROVEN |

## Next implementation slices

1. Provider sandbox adapters and signed webhook inbox.
2. Exact-once reconciliation worker with backoff and operator review queue.
3. Device onboarding/pairing and health checks.
4. Booking-detail launch point and server-authoritative cart loader.
5. Split/partial tender and refund workflows.
6. One-salon hardware pilot, then allowlisted rollout based on evidence.


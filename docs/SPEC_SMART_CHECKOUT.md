# NailIQ Smart Checkout

Status: **Phase B implemented locally; QA database/provider proof pending**
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

## Phase B safety layer

- Injectable Square Terminal and Stripe Terminal sandbox adapters. Provider
  access fails closed unless the runtime is explicitly sandbox-gated.
- Device-pairing adapters for Square device codes and Stripe reader
  registration. Raw Stripe registration codes are one-use memory only; the
  database stores at most a one-way pairing-code fingerprint.
- Dedicated, sandbox-only Square and Stripe webhook endpoints. Signatures are
  checked against the raw request body before any normalized event is stored.
- PII-free webhook inbox with provider event dedupe and exact
  salon/account/location/device/session binding.
- Leased reconciliation claims with bounded exponential backoff. The worker
  can only retrieve the existing checkout; it contains no checkout-dispatch
  path.
- `paid` requires an authoritative payment/receipt ID and exact account,
  checkout, device, location, amount, currency, and provider timestamp.
- Any binding or one-cent mismatch moves to manual review. A signed webhook
  schedules reconciliation but can never mark a checkout paid by itself.
- All Phase B tables remain FORCE RLS/service-only, with mutations limited to
  six narrow `SECURITY DEFINER` RPCs.

Phase B remains inert in every environment unless its separate sandbox flags
are enabled. The migration has not been applied to QA or Production, the
provider transports have not been called, and no salon is pilot-enabled.

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
| Sandbox adapter state mapping | Local automated tests; no provider call |
| Signed webhook normalization/routing | Local automated tests; real delivery NOT_PROVEN |
| Reconciliation worker truth/duplicate guard | Local automated tests; scheduled provider read NOT_PROVEN |
| Device pairing contract | Local automated tests; physical reader NOT_PROVEN |
| Phase B database lease/ACL | Static boundary tests; QA SQL apply NOT_PROVEN |
| Refund/partial tender | NOT_IMPLEMENTED in this foundation |
| Production money | OFF / NOT_PROVEN |

## Next implementation slices

1. Apply the Phase B migration to disposable QA and run the SQL boundary test.
2. Configure dedicated provider sandbox credentials and signed webhook URLs.
3. Exercise pairing and the response-loss/replay matrix with provider sandbox
   hardware/simulated readers; keep dispatch and every salon OFF.
4. Wire the certified sandbox transports into the existing reconciliation
   cron behind a separate read-only gate and add the operator review queue.
5. Add the booking-detail launch point and server-authoritative cart loader.
6. Implement split/partial tender and refund workflows.
7. Run one allowlisted salon hardware pilot only after every readiness gate is
   evidence-backed.

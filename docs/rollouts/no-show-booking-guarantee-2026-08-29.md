# No-show Booking Guarantee rollout

Date: 2026-08-29
Baseline: `origin/main` at `a5d558d242dcfc675347ffec9e978a8f57390022`

## Product promise

Marking attendance, deciding a fee, and moving money are three different acts.
NailIQ must never imply that a no-show was charged merely because attendance
was committed. A fee can move only after exact customer consent, an immutable
Owner/Admin approval receipt, a release gate, a salon allowlist, an
authoritative payment operation, and provider reconciliation.

## Current evidence ledger

| Capability | State | Evidence |
| --- | --- | --- |
| 60-second reversible no-show attendance decision | Production-proven backend; UI production flow not proven in this rollout | Existing Phase 1 rollout and current main |
| Post-commit waitlist and owner notification effects | Implemented and previously tested | Existing no-show safety boundary |
| Exact bilingual policy readiness and immutable policy version | Implemented; local tests | This change |
| Returning-card consent reuse only under the exact current policy | Implemented; local tests | This change |
| Separate fee review and immutable Owner/Admin receipt | Implemented; local disposable DB rehearsal | This change |
| Deterministic AI-assist recommendation with reason codes | Implemented; local only | This change; recommendation never authorizes payment |
| Approved no-show charge dispatch | Implemented behind two default-off gates; not invoked | Environment gate plus per-salon allowlist |
| Square payment webhook delivery truth | Implemented behind a default-off ingestion gate; local disposable DB rehearsal | Signed route projection plus durable inbox/RPC |
| Customer no-show notice and appeal workflow | Not implemented | Future phase; no message is sent by this change |
| Real Square sandbox charge | NOT_PROVEN | Requires separate provider-call approval |
| Production money movement | Disabled and NOT_PROVEN | Requires separate release certification and approval |

## Completed safety phases

### Phase 0 — policy and consent integrity

- Enabling no-show protection requires complete English and Vietnamese policy
  text with no bracket placeholders.
- Every saved-card consent is stamped with an exact SHA-256 policy version,
  fee, currency, and booking-member/whole-party scope.
- Automatic returning-card reuse fails closed when the current policy does not
  exactly match the booking consent.
- A held or paid deposit blocks creation of a second no-show fee review.

### Phase 1 — attendance and human approval truth

- A committed no-show automatically attempts to create a fee review; failure
  never rolls back the already-committed attendance result.
- Receptionist/Senior may originate the attendance action; only Owner/Admin may
  approve Charge or Waive.
- Approval creates an immutable receipt and leaves payment status
  `dispatch_blocked`; approval alone never calls Square.
- Both legacy and guided setup dashboard paths expose the Owner review queue.

### Phase 2 — payment delivery truth, default off

- Dispatch requires both
  `NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH=true` and salon feature flag
  `approved_no_show_charge_dispatch=true`.
- SQL revalidates the immutable approval receipt and produces a stable request
  ID for the authoritative payment ledger.
- Signed Square payment events are reduced to a PII-free projection, deduped,
  bound to exact provider account/location/environment/amount/currency, and
  reconciled in timestamp order.
- Failed or uncertain operations are not blindly retried.
- Payment-event ingestion separately requires
  `NAILIQ_SQUARE_PAYMENT_WEBHOOK_INGESTION=true`, preventing an app-first
  rollout from calling a not-yet-installed database RPC.

## Required rollout sequence

1. Apply the migration to a disposable Supabase QA project and rerun the SQL
   transaction rehearsal. No Square call is needed.
2. Verify a branch-scoped QA Preview with synthetic data for receptionist request, Owner
   approve, Owner waive, replay, guided setup, and group-member scope.
3. Merge only after CI, independent review, and the QA Preview verification are
   green. Keep charge dispatch and payment-webhook ingestion gates OFF during
   the automatic application deploy.
4. Apply the production migration, verify all new tables/RPCs, FORCE RLS,
   service-role-only grants, zero salon allowlist, and zero new rows. Only then
   enable payment-webhook ingestion; charge dispatch remains OFF.
5. Observe fee review creation and webhook ingestion without money movement
   for at least 48 hours.
6. Obtain Canadian legal/policy review of fee disclosure, card consent,
   cancellation terms, accessibility, and charge dispute/appeal wording.
7. With separate approval, enable Square **sandbox** for one QA salon and one
   synthetic card. Prove success, decline, timeout/unknown, duplicate click,
   out-of-order webhook, refund/dispute handoff, and kill switch.
8. With a new production approval, allowlist one salon while the environment
   gate remains controllable as the global kill switch. Start with Owner manual
   approval only and monitor receipts/ledger/provider equality for 72 hours.
9. Expand gradually only if charge attempts, final outcomes, disputes,
   complaints, and reconciliation gaps stay within the agreed thresholds.

## Production stop conditions

- Any mismatch among booking, salon, Square account/location/environment,
  amount, currency, policy version, card fingerprint, or approval receipt.
- Any `unknown`, duplicate, or terminal-state conflict without reconciliation.
- Any charge on a booking protected by a held/paid deposit.
- Any salon or customer report that UI wording implied payment before provider
  confirmation.
- Missing webhook, ledger, or immutable approval evidence.

## Next product phase

Build customer notice/appeal as a separate, approval-bound workflow: clear fee
reason and evidence, one-tap contact/appeal, Owner inbox SLA, bilingual status,
and durable delivery receipts. Do not use an LLM to decide a charge. AI may
summarize evidence, prioritize reviews, draft bilingual explanations, and flag
exceptions; a human and the authoritative payment ledger remain decisive.

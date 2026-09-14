# P1-02 — Head Spa and legacy card-protection exceptions (2026-09-14)

## Scope and evidence class

- Isolated branch: `audit/p1-02-head-spa-20260914`
- Base and current Production SHA: `f0b49628e8aa35e6cf4a97b369a160ff531c04bc`
- Production inspection: read-only aggregate queries; no customer name, phone, email,
  card identifier, customer identifier, or provider secret was returned.
- Provider calls, messages, charges, booking mutations and Production writes: none.
- Local code status: implemented and verified; not committed, pushed, previewed or deployed.

## Production truth at 2026-09-14 21:36 UTC

| Salon | Future non-cancelled | Future exceptions | Saved and active | Required without card | Potentially chargeable |
|---|---:|---:|---:|---:|---:|
| Hi-Lite Head Spa | 13 | 5 | 2 | 4 | 0 |
| Hi-Lite Studio | 4 | 4 | 0 | 4 | 0 |

The nine future exceptions are confirmed appointments. Eight are `awaiting_card`
with no card/customer/brand/last4/consent and no save-card operation. One Head Spa
appointment is correctly `manual_review`: the booking has card display fields and one
`succeeded` operation, but its provider/customer binding does not match and its consent
policy version is not a current `nsp_<sha256>` receipt. It must not be called protected
or retried by blindly creating another card.

There are 662 additional past exceptions: 508 at Head Spa and 154 at Studio. They are
completed, no-show, or past confirmed appointments. They cannot activate protection for
an appointment that has already passed and should not occupy the owner's active exception
queue. Provider-operation diagnostics remain durable outside this UI projection.

Both salons use Square and have no-show protection enabled. No booking in the inspected
set had a pending or processing no-show charge. Application charge paths separately
require `card_protection_status = 'saved'`; the legacy Head Spa row remains
`manual_review` despite its older `noshow_charge_status = 'saved'` value.

## Root cause and local fix

`loadCardProtectionExceptions` excluded only `cancelled` bookings. It therefore returned
completed, no-show and past confirmed appointments as if their card protection still
needed appointment-time action.

The local query now returns only future `pending` or `confirmed` bookings in an inactive
card-protection state. Tenant, owner/admin, minimal-disclosure and provider-reconciliation
boundaries are unchanged.

## Verification

| Gate | Result |
|---|---|
| Focused unit test | PASS — 8/8 |
| Real Supabase QA Auth/integration | PASS — 13/13 |
| Past completed exception in real QA Postgres | PASS — excluded while two future exceptions remained visible |
| Two-tenant and six-role access matrix | PASS — only Owner/Admin of the matching salon received the list |
| Retry-link race | PASS — three simultaneous actions returned one durable capability |
| Demotion, membership removal and session revocation | PASS — access removed immediately |
| QA outbound/payment boundary | PASS — SMS, email, call and payment dispatch remained disabled |
| QA cleanup | PASS — zero active memberships, undeleted bookings, unexpired capabilities or enabled outbound flags |
| Touched-file ESLint | PASS |
| Next production build | PASS |
| TypeScript `tsc --noEmit` after build | PASS |

The first build attempt failed before compilation because Turbopack rejects a
`node_modules` symlink outside the worktree root. Installing the lockfile dependencies
inside the worktree resolved the environment issue; the unchanged build command then
passed.

## Remaining operational acceptance

1. Publish the active-appointment filter through a reviewed PR and Preview.
2. Owner reviews the eight future `awaiting_card` appointments and generates secure,
   expiring retry links only for the intended customers.
3. The one Head Spa `manual_review` appointment must collect fresh policy consent and use
   read-only Square verification of the existing card before any new tokenization.
4. Run one authorized Head Spa recovery journey through the real browser/provider and
   confirm durable consent, customer binding, card receipt and reload state. Do not charge.

## Verdict

- Existing Production charge safety: **PASS**
- Local exception-list defect and regression: **PASS**
- QA Auth, tenant, race and cleanup: **PASS**
- Preview verification of this change: **NOT RUN**
- Head Spa provider recovery journey: **NOT RUN**
- P1-02 overall: **NOT YET COMPLETE**

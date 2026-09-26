# Cancellation email fee action — local acceptance

Date: 2026-09-26. Branch: `feat/cancellation-email-fee-action-20260926`.
Base: `be35585e26ca89ef11193a4ef765ad24a8937084` (PR #1432).
Status: implemented locally; not committed, pushed, Preview-deployed or Production-deployed.

## Problem and resulting behavior

Cancellation emails previously opened the general dashboard. Owner/Admin had
to find the booking and fee queue. The cancellation CTA now opens exactly
`/dashboard/[slug]/cancellation-fee/[bookingId]`, with normal authenticated
sign-in preserving this strictly allowlisted destination.

The focused bilingual page shows appointment/service, salon-local time, exact
fee currency/amount, masked card and payment status. Explicit confirmation can
record approval then call the existing approved-cancellation dispatcher. Email
GET, authentication callback, page loading and modal opening never approve or
charge. Existing delivery settings, recipient resolution and outbox dedupe are
preserved. No new message channel or recipient is introduced.

## Security and payment boundary

- Loader checks real member session + Owner/Admin before service-role reads.
- Every query is salon-scoped; review lookup targets the exact booking, not a
  paginated queue or a group member's organizer by inference.
- Action validates identifiers and rendered amount/currency/card/consent
  snapshot, rereads after approval and stops on changed or uncertain state.
- Existing approval RPCs/immutable receipts and payment ledger remain the
  authority for provider binding, consent cap, idempotency and concurrent claims.
- No schema migration, provider gate or notification configuration changed.
- Existing review material has no application edit path and service_role has
  SELECT-only access. Application pre-read is not a SQL compare-and-swap against
  hypothetical direct DBA changes; do not claim that stronger guarantee.
- Failed/unknown/pending-provider/dispatching/waived/not-applicable states do not
  offer collection. A succeeded review returns its saved successful state.

## Validation

PASS:

- Full Vitest: 872 files passed, 7 skipped; 7,158 tests passed, 79 skipped.
- TypeScript `npm run typecheck` and lint all touched TS/TSX files.
- `next build --webpack`, sequential production build with QA environment.
- `git diff --check`.
- Real Chrome using local production build and disposable Supabase QA
  `osdqutwunokiielbairj`: signed-out exact booking URL -> password sign-in using
  existing synthetic Owner -> same exact review.
- Desktop and mobile 390x844: correct CAD 50.00 + VISA last4 1111; explicit modal;
  cancel modal + reload keeps approved/not-collected truth; English/Vietnamese;
  mobile document width equals scroll width (390).
- Not-applicable fixture has no collection button. Individual group member has
  no organizer fee. Salon A URL + salon B booking returns 404.
- QA ledger after browser checks: zero payment operations and zero new owner
  notification rows for the two synthetic fixture salons.

Blocked / not proven:

- Turbopack build failed twice at OS port binding (`EPERM`); supported Webpack
  production build passed. Hosted default build is not yet verified.
- Initial unit run had localhost sandbox EPERM and missing new-route inventory.
  Inventory was expanded with real page/loader role tests; final unrestricted
  localhost unit run passed all non-skipped tests.
- Automatic action review rejected the final browser collection click as a
  financial action requiring user handoff, despite QA dispatch=false. No final
  collection click, provider request, alternate dispatch, real payment or extra
  Sandbox payment was performed. Final UI submission remains unverified.
- Email content/routing was verified with mocked transport; no real email sent
  and inbox delivery is not claimed.
- QA provider notifications, SMS, email, calls, card save and payment dispatch
  were all OFF. No Production mutation or real-customer test.
- Existing local browser sessions initially routed to setup/404; a separate
  Chrome session successfully verified the intended signed-out flow.
- Forgot-password/account-creation detours retain existing generic destinations.

## Production read-only observations

Both `hilite-anaheim` and `hilite-studio` have owner alerts and cancellation
alerts enabled. Anaheim uses its existing configured extra recipient; Studio
also enables member notifications. This proves settings only, not delivery of
the new template. No settings or recipients were changed.

## Evidence and release/rollback

Evidence: `/Users/huytran/nailiq-cancellation-email-evidence-20260926/`:
mobile-vi.png, mobile-confirmation.png, blocked-vi.png, member-no-fee-vi.png,
cross-tenant-denied.png, unit-final.log, typecheck-final.log, build-webpack.log.

Next gate: approval to commit/push, open PR and create isolated QA Preview;
verify hosted auth return, rendering and default build on the exact candidate.
Production release needs its explicit authorization and hosted checks first.

Rollback is application-only: revert this scoped release/deploy previous app
version, leaving database receipts and payment gates unchanged. Old emails with
the new route may then return 404; Owner/Admin can use the existing
`/dashboard/[slug]/no-show-protection` queue. Never delete/roll back financial
receipts or retry a provider call to perform rollback.

## Waiver update — 2026-09-26

User approved adding a direct waiver alongside collection. Pending reviews now
offer bilingual `Waive cancellation fee` / `Miễn phí hủy`, with a separate
confirmation modal. This uses existing `decide_*` RPCs with action=waive, records
actor/time in the immutable approval receipt, and never calls the dispatcher.
Valid card metadata is not required to waive. Already-approved, paid, unknown,
failed, invalidated and not-applicable reviews cannot be waived by this action.
This is not a refund or reversal of an existing approved decision.

The RPC's row lock arbitrates charge/waive races: the first valid pending
decision wins. A losing waiver never reports success when charge won. A losing
duplicate waiver may return success only after an authenticated reread proves
the exact fee is already waived. No blind mutation replay is performed.

Latest gates: 7,173 unit tests passed / 79 skipped (872 files passed, 7 skipped),
typecheck, touched-file lint and sequential Webpack production build PASS.
73 focused action/UI tests passed before the full suite. No migration needed.

Real Chrome, local production build + disposable hosted Supabase QA:
- Created a dedicated synthetic cancelled booking `fc260927-0000-4000-8000-000000000030`
  and pending review `fc260927-0000-4000-8000-000000000032`, under `e2e-cap-valid-pr1432`.
  No contact information or provider card credentials on the new booking.
- Both collect/waive choices rendered; opened waiver confirmation at 390x844.
- Confirmed the synthetic waiver through the real UI, then reloaded.
- UI retained `Đã miễn phí — không thu tiền`, with neither collect nor waive button.
- Database: waived/not_authorized, matching Owner actor, timestamp recorded,
  booking remains cancelled, exactly one waiver receipt, zero payment operations.
- Evidence: `waiver-confirmation-mobile.png`, `waived-after-reload-mobile.png`
  in the same external evidence directory; `waiver-unit.log`,
  `waiver-typecheck.log`, `waiver-build.log`.

This waiver submission was verified. The previously blocked final **collection**
click remains unverified and was not retried. No email/SMS/payment was sent.
Still local/QA only; no commit/push/Preview/Production release in this update.

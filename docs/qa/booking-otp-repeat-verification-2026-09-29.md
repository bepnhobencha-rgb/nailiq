# Booking OTP repeated-verification ledger rehearsal — 2026-09-29

Status: **local and disposable QA rehearsed; not Production-deployed or
Production-verified**. This is a
focused P1-01 receipt-integrity follow-up, not proof that SMS delivery or the
whole Day 9 plan is complete.

## Evidence boundary

- A read-only Production log inspection found one `provider_identity_conflict`
  while `/api/booking-otp/send` returned HTTP 200 after Twilio accepted the
  request. The same delivery-attempt row was later marked verified when the
  customer entered the code. This is evidence of an incomplete provider
  correlation receipt, not evidence that the SMS was lost. No recipient, code,
  fingerprint, or provider identifier is recorded here.
- The existing database index requires a provider request ID to be globally
  unique. Twilio Verify can produce multiple send attempts under one
  Verification SID; each send attempt has its own attempt SID. The Production
  incident is consistent with a repeated Verification SID but its exact
  provider response was not captured, so that cause remains an inference.
  Provider reference: https://www.twilio.com/docs/verify/api/attempts and
  https://www.twilio.com/docs/verify/api/rate-limits-and-timeouts.
- The live Vercel deployment was identified by deployment ID, but it has no
  source SHA in its metadata. The exact serving source commit remains unproven.

## Additive schema correction

`20260929072300_scope_booking_otp_provider_request_uniqueness.sql` keeps
Resend message IDs unique and keeps Twilio send-attempt IDs unique. It changes
the Twilio Verification SID from a globally unique key to an indexed lookup.
It does not rewrite ledger rows or change table RLS, function grants, or
customer-facing behavior.

The application should keep reporting a failed ledger completion if the
provider returns an actually duplicated send-attempt ID. This migration does
not treat two distinct SMS sends as one send or prove carrier delivery.

## Tests run

- Isolated local PostgreSQL with the original OTP schema: the synthetic
  second send under the same Verification SID fails with
  `provider_identity_conflict` (expected reproduction).
- Same isolated database after the index migration: the complete OTP ledger
  regression script passes, including a second Twilio send with a distinct
  attempt SID, a duplicate attempt SID rejection, a duplicate Resend message
  ID rejection, and existing role/tenant boundary checks. The test runs in a
  transaction and rolls back its synthetic rows.
- `npm run db:history:audit -- --deploy-ready`: PASS; 267 inspected Production
  migration-history rows matched the local ledger. This is a history audit,
  not a QA migration rehearsal or a live-schema inspection.
- Folded migration-history generation: PASS with the new migration among the
  forward migrations.
- Supabase QA project `uhpzafoiifupyypkcwln`: the migration applied
  successfully. Metadata showed the old globally unique request index absent,
  the Resend request index unique, the Twilio request lookup nonunique, and
  the provider-attempt index still unique. RLS and FORCE RLS stayed enabled.
  Direct ledger SELECT for `anon`, `authenticated`, and `service_role` remained
  denied; the completion RPC stayed executable only by `service_role` among
  those roles.
- The full SQL regression ran on that QA project in one transaction with a
  synthetic salon and rolled back. The follow-up read found zero ledger rows
  and no synthetic salon left. No provider was called.
- QA security advisors had no finding on the OTP ledger. Performance advisors
  reported the new Twilio lookup as unused, expected with zero ledger rows;
  other project-wide advisories predate this focused change and were not
  claimed as resolved. See the [Supabase unused-index lint](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index).
  Full PR CI is a separate gate.
- First PR CI build/type-check job **failed** because two exact-count contract
  tests still expected 1,021 indexes after the migration added one net index.
  The tests now expect 1,022, matching the schema-parity source. Focused local
  Vitest rerun passed (16/16 across three files), and `npm run typecheck`
  passed. The first failed run remains part of the evidence; the new PR head
  must pass CI independently.

## Rollout / rollback boundary

Do not apply this migration to Production from this QA result. A Production
rollout needs a separate explicit approval and checks before/after the single
migration. Because future rows may
share a Twilio Verification SID, restoring the old global unique index is not
a safe blind rollback. Preserve the append-only ledger, inspect any duplicate
SID rows, and plan a corrective migration if schema reversal is necessary.

No OTP, SMS, email, booking, payment, or provider call was made in this test.

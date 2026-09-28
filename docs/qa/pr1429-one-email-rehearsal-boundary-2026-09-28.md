# PR #1429 — one-email QA rehearsal boundary

Status: implemented and tested locally only. No provider call, email, booking, secret, Preview environment, Production data or deployment was changed in this checkpoint.

## Why the previous Preview cannot prove delivery

The branch-specific Preview has `DISABLE_OUTBOUND_EMAIL=1`. The one-shot card-retry claim correctly stops before creating a receipt. Turning the shared switch off would also unblock unrelated email senders in the same Preview. A browser suppression test is therefore not provider acceptance or inbox proof.

## Scoped test design

Keep `DISABLE_OUTBOUND_EMAIL=1`. The card-retry claim and shared link-email sender may bypass that switch **only** when all of these server-side conditions hold:

- `NAILIQ_QA_CARD_RETRY_EMAIL_ENABLED=1` and a valid, exact `NAILIQ_QA_CARD_RETRY_EMAIL_BOOKING_ID` match the action's booking;
- the existing Resend QA boundary verifies `VERCEL_ENV=preview`, `NAILIQ_DISPOSABLE_DB=1`, a non-Production pinned Supabase project, matching public/internal URLs, and one pinned recipient;
- the actual booking email matches the pinned recipient;
- the send requires a provider receipt and the durable card-retry idempotency key;
- existing dashboard authorization, tenant-scoped booking lookup, booking eligibility, opt-out/suppression and the single-claim receipt still pass.

This is not a general QA email enablement. Other email paths remain behind the global switch. Missing/mismatched configuration fails closed. The receipt permits at most one send attempt for that booking; a provider transport timeout remains an **unknown** outcome, not permission to retry blindly.

## Rehearsal gate — not yet authorized or executed

Before a real one-email test, obtain one explicit approval naming the recipient and authorizing a temporary Resend Sending-only credential, one synthetic QA booking, branch-specific Preview configuration/deployment, one send, and cleanup. Verify the exact Preview SHA, QA project/ref, recipient pin, global email/SMS/call/payment suppression, and access restriction. Do not enable a shared-account QA webhook without separate approval: signed live events could transiently reach it. Use no real salon/customer data.

After a single send, read the durable receipt and provider message ID, then verify inbox delivery separately. Disable the scoped rehearsal flag, redeploy, revoke the temporary credential, and clean only the synthetic fixture. Preserve receipt evidence needed to diagnose a send or an unknown outcome. Never click the card link or call payment APIs during this email-only rehearsal.

## Local verification

- 38 focused QA-boundary, receipt and shared-sender tests: PASS.
- 26 existing save-card channel tests: PASS.
- Typecheck, touched-file ESLint and Webpack production build with global outbound switches disabled: PASS.

These checks do not prove hosted Preview configuration, Resend acceptance, delivery to an inbox, or Production safety. PR #1429 remains Draft until its independent reliability and provider gates are resolved.

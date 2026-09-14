# P1-01 — Notification delivery truth (2026-09-14)

## Scope and evidence class

- Branch: `audit/p1-01-notification-delivery-20260914`
- Base and current Production SHA at audit start: `4480f7d9ee42409622b171c78dd67a8a25d16bf7`
- Production mutation: none
- Provider dispatch: none
- Synthetic data only
- Overall release state: **LOCAL PASS; QA/Preview/Production NOT YET VERIFIED**

## Existing before this task

- Waitlist SMS and email dispatch used a durable, one-attempt domain outbox.
- Twilio callbacks were stored in `sms_delivery_attempts`.
- Signed Resend callbacks were stored in `registered_email_delivery_events`.
- Provider acceptance was distinct from terminal delivery in those callback ledgers.
- The Receptionist Center loaded only `waitlist_offer_delivery_outbox`, so a row that
  reached `sent` at provider acceptance could remain visually successful after a later
  `undelivered`, `failed`, `bounced`, or `complained` callback.

## Implemented locally

- Added service-role-only RPC `load_waitlist_offer_delivery_truth`.
- The RPC is scoped by `salon_id`, limited to 1–100 entry IDs, and returns no recipient,
  phone, email, fingerprint, provider message ID, or receipt.
- Twilio truth is joined by salon, purpose, provider SID, and recipient fingerprint.
- Resend truth is joined by provider message ID, purpose, audience, one recipient, and
  recipient fingerprint.
- Terminal Resend outcomes outrank late/reordered provider-accepted callbacks.
- Receptionist UI now separates:
  - `Provider accepted` / `Provider đã nhận` (informational)
  - `Delivered` / `Đã giao` (success)
  - terminal failure/suppression/unknown states (attention)
- No provider retry or customer notification was added.

## Local verification

| Gate | Result |
|---|---|
| Focused notification/reminder/waitlist/security tests | PASS — 296/296 |
| Full unit suite | PASS — 6,313 passed, 65 skipped |
| New focused tests | PASS — 14/14 |
| Touched-file ESLint | PASS |
| i18n validation | PASS — 0 errors; 13 pre-existing warnings |
| Next production build | PASS |
| TypeScript `tsc --noEmit` after build | PASS |
| Migration history audit | PASS — no duplicate/mismatch/Production-only version |
| Folded migration reconstruction and directory diff | PASS |
| PostgreSQL 17 migration apply on disposable local DB | PASS |
| Synthetic terminal behavior | PASS — Twilio undelivered and Resend bounced project as failed |
| Reordered callback behavior | PASS — late provider-accepted callback cannot downgrade failure |
| Tenant isolation and browser-role grants | PASS |
| Oversized request (101 IDs) | PASS — returns no rows |

## What remains before acceptance can close

1. Commit/push only after owner approval.
2. Run CI blank-Supabase migration rehearsal, including the extended waitlist script.
3. Create an isolated QA Preview and apply the additive migration to disposable QA.
4. Verify the Receptionist Center in a real browser for accepted, delivered, failed,
   suppressed, and unknown states in both languages and mobile/desktop widths.
5. If provider credentials are provisioned for disposable QA, run one synthetic Twilio
   and one synthetic Resend delivery/callback case with Production notifications and
   payment dispatch disabled.

## Rollout and rollback boundary

- Rollout order: additive migration first, then application code.
- If application code arrives before the RPC, the loader fails closed to `unavailable`;
  it does not report a false success and does not retry a provider.
- Rollback application code first. After all callers are on the old loader, remove the
  additive function with:
  `DROP FUNCTION IF EXISTS public.load_waitlist_offer_delivery_truth(uuid, uuid[]);`
- The migration changes no table data and creates no trigger, cron, charge, SMS, or email.

## Acceptance verdict

- Waitlist terminal delivery read-model defect: **LOCAL PASS**
- P1-01 end-to-end QA/provider/Preview acceptance: **NOT YET COMPLETE**
- V1/Master Plan/784-function completion: **NOT CLAIMED**

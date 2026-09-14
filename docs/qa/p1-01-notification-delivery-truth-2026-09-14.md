# P1-01 — Notification delivery truth (2026-09-14)

## Scope and evidence class

- Implementation branch: `audit/p1-01-notification-delivery-20260914`
- Browser-acceptance follow-up: `qa/p1-01-acceptance-20260914`
- Base Production SHA at audit start: `4480f7d9ee42409622b171c78dd67a8a25d16bf7`
- Production SHA reverified after merge: `9db731b6860f77f6eef85c3686f80cb4bb5f22c5`
- Production migration: `20260914155026 waitlist_offer_terminal_delivery_truth`
- Provider dispatch: none
- Synthetic data only
- Overall release state: **DEPLOYMENT PASS; SYNTHETIC BROWSER PASS; PROVIDER QA NOT YET VERIFIED**

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
| PR and CI | PASS — PR #1406 merged; build, blank-Supabase rehearsal, receptionist desktop/mobile E2E, security and visual checks succeeded |
| Production version/health | PASS — `/api/version` returned `9db731b6860f77f6eef85c3686f80cb4bb5f22c5`; `/api/health` returned HTTP 200 |
| Isolated fixture build | PASS — imports the production `OnlineWaitlistPanel`; Next webpack production build and TypeScript passed |
| Browser matrix | PASS — 4/4: Chromium desktop and iPhone 14 WebKit, English and Vietnamese |
| Browser state truth | PASS — accepted, delivered, failed, suppressed, unknown, and sending all rendered; only delivered uses the success token |
| Mobile layout | PASS — no horizontal overflow; full-page screenshot visually inspected |
| Fixture network boundary | PASS — non-local requests and every non-GET/HEAD request were blocked; no provider or database call |
| Follow-up focused unit tests | PASS — 10/10 |
| Follow-up touched-file ESLint | PASS |
| Follow-up root typecheck | PASS |

## What remains before acceptance can close

1. Commit/push the reusable browser-acceptance fixture only after owner approval.
2. Create an isolated QA Preview and apply the additive migration to disposable QA.
3. If provider credentials are provisioned for disposable QA, run one synthetic Twilio
   and one synthetic Resend delivery/callback case with Production notifications and
   payment dispatch disabled.

The browser requirement is now proven locally against the production component. It is
not called Preview evidence until the same fixture has been deployed to isolated QA.

## Rollout and rollback boundary

- Rollout order: additive migration first, then application code.
- If application code arrives before the RPC, the loader fails closed to `unavailable`;
  it does not report a false success and does not retry a provider.
- Rollback application code first. After all callers are on the old loader, remove the
  additive function with:
  `DROP FUNCTION IF EXISTS public.load_waitlist_offer_delivery_truth(uuid, uuid[]);`
- The migration changes no table data and creates no trigger, cron, charge, SMS, or email.

## Acceptance verdict

- Waitlist terminal delivery read-model defect: **PRODUCTION DEPLOYMENT PASS**
- Synthetic desktop/mobile EN/VI browser acceptance: **PASS**
- P1-01 provider/Preview acceptance: **NOT YET COMPLETE**
- V1/Master Plan/784-function completion: **NOT CLAIMED**

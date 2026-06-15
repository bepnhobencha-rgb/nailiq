# NailIQ — Go-Live Runbook

_Last updated: 2026-06-15. Consolidates the pre-launch security + verification pass._

## 1. Status at a glance

| Area | State |
|---|---|
| `tsc` / `next build` | ✅ Clean (47/47 pages) |
| Smoke test (dashboard + public booking, prod) | ✅ 0 console errors |
| Square/Stripe money path | ✅ Audited clean + hardened |
| Customer-PII leaks | ✅ Sealed + verified |
| Account-takeover surface | ✅ Audited, no critical bug; hardened |

## 2. Must-do BEFORE opening to more salons (config — non-breaking)

These are dashboard toggles the code can't flip; each is non-breaking (affects only new passwords / new logins).

- [ ] **Supabase Auth → enable "Leaked password protection" (HIBP).** Blocks users from setting breached passwords. (Authentication → Policies/Passwords.)
- [ ] **Confirm "Confirm email" is ON** (Authentication → Providers → Email). The membership-claim RPC now enforces a confirmed-email guard in-DB regardless, but keep this on.
- [ ] **Vercel Firewall → create rate-limit rule `card-save`** (~5 req / 60s, key = IP). The app already enforces a DB-backed limiter (6/min) on the card-save routes; this is the second (edge) layer. Requires Pro (✅ on Pro).
- [ ] **Verify env on Vercel _production_:** `NAILIQ_TEST_BYPASS_SLUG_PIN` and `DEMO_OTP`/`NEXT_PUBLIC_DEMO_OTP` are NOT set (they enable the demo-cookie bypass). `ANTHROPIC_API_KEY`, `STRIPE_*`, `SUPABASE_SERVICE_ROLE_KEY` ARE set.

## 3. Recommended soon (not blocking)

- [ ] **MFA (TOTP) for superadmin** — the one remaining account-takeover hardening that needs code (enroll + verify UI + login gate). Build as a focused task.
- [ ] **Third-party pentest / bug bounty** before scaling to many paying tenants — the internal audits (opus) are thorough but don't replace external testing.
- [ ] **Stripe Connect routing for no-show charges** (LOW) — currently the Stripe no-show charge would hit the platform account; gate the Stripe no-show provider behind a connected-account check before enabling it for any salon (none use it today; Hi-Lite uses Square).
- [ ] **Lint sweep** — ~58 pre-existing `no-explicit-any` style errors in `src/` (don't block the build). Clean incrementally when touching each file; there's a WIP stash for this.

## 4. What was hardened this pass (for the record)

Security fixes — all applied to prod + verified (anon blocked, app paths intact):

- **CRITICAL** `search_salon_clients` anon EXECUTE → revoked (was a live full-PII dump). (#488)
- **HIGH** `get_booking_client_snapshot` → salon-scoped overload, legacy dropped. (#488/#490)
- **HIGH** `salon_resources` open anon read → dropped. (#488)
- **HIGH** `claim_salon_memberships_by_email` → in-DB confirmed-email guard. (#502)
- **HIGH** password min 6 → 8 (both reset actions). (#502)
- **MED** `client_profiles` public write policies → dropped. (#488)
- **MED** card-save routes → WAF + DB rate-limit (2 layers); deposit amount assertion. (#494/#498)
- **MED** `staff` writes → gated to owner/admin (was any-role). (#504)
- **MED** `party_link_change_requests` → locked to service-role (was open anon). (#504)

Money path verified safe: server-side amounts, secrets service-role-only, role-gated charges, signed idempotent Stripe webhooks, PCI-tokenized (no raw card data server-side).

## 5. Monitoring after go-live

- **Self-hosted error monitor** (already live): captures → AI triage (Haiku cron) → AI-draft fix PRs on `ai-fix/*` (never auto-merged). Watch the dashboard for spikes after launch.
- **Sentry**: surface tag `surface=dashboard|booking|custom-domain|superadmin`.
- **Supabase advisors**: re-run `get_advisors(security)` after any new migration — the anon-grant-on-new-RPC trap recurs (it bit us twice). Code-review every new `SECURITY DEFINER` migration for the `REVOKE ... FROM anon` tail.

## 6. Rollback

- Vercel keeps `isRollbackCandidate` production deploys — promote a previous one from the dashboard if a deploy regresses.
- DB migrations this pass are additive/restrictive (REVOKE/DROP POLICY/guards). To roll back a specific one, re-grant / re-create the dropped policy — but prefer fixing forward (the dropped grants were attack surface, not app dependencies).

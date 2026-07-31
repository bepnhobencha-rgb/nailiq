# [Milestone #1012+]: Resend migration and activation runbook

## Summary
- Complete migration tooling hardening for resend rollout after package upgrade to Pro.
- Add safe scripts for preview/apply/verify + status reporting and artifact checks.
- Keep PR #1012-related artifacts present and verified.

## Why
- Resend is now Pro and all active salons should have `email_outbound_enabled = true` so outbound email flows use Resend consistently.

## Changes
- [ ] Added/updated scripts:
  - `scripts/enable-all-salons-email-outbound.mjs` (fail-fast when remaining items after apply)
  - `scripts/migrate-and-verify-resend.sh`
  - `scripts/verify-os-milestone-1012.mjs`
  - `scripts/report-resend-migration-status.mjs`
- [ ] Added npm scripts:
  - `migration:resend-run-strict`
  - `resend:status`
- [ ] Updated migration documentation:
  - `docs/resend/RESEND_MIGRATION.md`

## Required checks (local)
- [ ] `npm run typecheck`
- [ ] `npm run test:unit -- src/shared/ai/__tests__/strategistProposal.spec.ts`
- [ ] `npm run verify:milestone-1012`
- [ ] `npm run lint -- scripts/verify-os-milestone-1012.mjs`

## Production rollout
1. Run status pre-check:
   - `npm run resend:status`
2. Run strict migration:
   - `FORCE_APPLY=1 npm run migration:resend-run-strict`
3. Run status post-check:
   - `npm run resend:status`
4. Verify API health:
   - `curl -sS https://www.nailiq.ca/api/version`
   - `curl -sS https://www.nailiq.ca/api/health`

## DoD
- [ ] No active salon remains with `email_outbound_enabled = false`.
- [ ] `migration:resend-run-strict` exits successfully.
- [ ] Required checks pass and PR is merge-clean.
- [ ] No production data loss risk introduced.


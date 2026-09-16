# NailIQ — Go-Live and Incident Runbook

_Last updated: 2026-09-16. Owner: NailIQ release operator._

This runbook is the production boundary for NailIQ. A green pull request proves
the candidate in CI; it does not prove that Production has the required schema
or that either live salon is healthy.

## 1. Release controls

- Git deployments from `main` are disabled in `vercel.json`. Merging code must
  not deploy Production automatically.
- Production database migration, application deployment/promotion and rollback
  are separate actions. Record the operator, UTC time, candidate SHA and result
  for each action.
- Use an isolated clean worktree at the exact candidate SHA.
- Do not use Production for fixture creation or destructive testing. Rehearse
  migrations, rollback, restore, offboarding and provider behavior on a
  disposable Supabase project with synthetic data first.
- Do not enable outbound notifications or payment dispatch for a rehearsal.

## 2. Required release order

Stop on the first failed or ambiguous step. Do not continue to make the release
look green.

### RELEASE-1 — Freeze and identify

1. Record the candidate branch and full SHA.
2. Record the current Production SHA from `https://www.nailiq.ca/api/version`.
3. Confirm the worktree is clean and the candidate checks are green.
4. List every migration added since the current Production SHA and identify its
   application compatibility boundary.
5. Confirm a rollback candidate and the schema compatibility of that rollback.

### RELEASE-2 — Apply schema first

1. Compare local and linked migration ledgers read-only.
2. Apply only the reviewed pending migration set to Production after explicit
   action-time approval.
3. Record the exact migration versions and command outcome. Never mark a
   migration applied unless its schema and behavior are already present.

### RELEASE-3 — Verify schema and behavior

Before deploying application code:

1. Re-read the migration ledger.
2. Run the migration-specific read-only schema/RPC/ACL probes.
3. Confirm tenant isolation and any fail-closed capability expected by the new
   application.
4. Run Supabase security advisors and classify new findings.

If any required RPC, table, trigger, grant or constraint is absent, stop. Do not
deploy the application.

### RELEASE-4 — Deploy the application

Deploy or promote the exact reviewed SHA manually. Record the deployment ID,
URL, start/ready timestamps and previous rollback candidate. Do not deploy from
a dirty checkout or a different SHA.

### RELEASE-5 — Run read-only canaries

1. Verify `/api/version`, `/api/health` and `/api/ready` report one matching SHA
   and healthy/ready status.
2. Open both live public salon pages in a real browser in English and Vietnamese.
3. Confirm the booking form renders and browser console has no error.
4. Review Production runtime logs for new HTTP 5xx or schema errors.
5. Confirm the independent Production monitor is green.

No customer data, provider mutation, charge, SMS, email or call is allowed in
these canaries. A booking submission needs a separately approved production
test plan.

## 3. Rollback

### ROLLBACK-A — Application regression

Use only when the previous application is compatible with the current schema.

1. Stop further promotion and record the incident start time.
2. Promote the recorded previous READY deployment.
3. Re-run the version/health/readiness probes and both-salon browser canary.
4. Keep additive schema in place unless a reviewed database rollback is needed.

### ROLLBACK-B — Schema or compatibility regression

Do not blindly promote old code across an incompatible schema.

1. Disable the affected entry point or use the documented feature kill switch.
2. Select the migration-specific rollback or a tested forward fix.
3. Rehearse that exact action on disposable QA before Production.
4. Apply it only with action-time approval, then verify schema, ACL, tenant
   isolation and the application canary again.

For data-loss or corruption recovery, restore a logical backup only into a new
isolated database first. Compare schema, data and application-contract
fingerprints before any cutover decision. The repository rehearsal is
`scripts/security/rehearse-postgres-backup-restore.mjs`; it refuses non-loopback
targets and requires `NAILIQ_DISPOSABLE_DB=1`.

## 4. Incident handling and support

1. **Detect:** capture UTC time, surface, route, deployment SHA and correlation
   identity. Redact secrets and customer/card data.
2. **Contain:** pause only the unsafe entry point; do not weaken auth, RLS,
   idempotency or provider-safety gates.
3. **Assign:** one incident owner records decisions and evidence. The GitHub
   Production Monitoring workflow opens or updates one incident issue for a
   failed version/liveness/readiness probe.
4. **Diagnose:** separate verified facts, hypotheses and unavailable evidence.
5. **Recover:** use the matching rollback branch above or a verified forward
   fix.
6. **Close:** confirm recovery with the same probes that detected the incident,
   add recovery evidence and close the incident. Record follow-up prevention.

The monitoring drill may be run manually with `simulate_failure=true`. It must
open/update the incident for the configured repository recipient and a later
healthy run must comment and close it. The drill never submits a booking or
contacts a salon/customer.

## 5. Staff offboarding

- Owner/admin previews affected future assignments before completing the action.
- Completion uses the atomic offboarding RPC; do not directly update/delete a
  staff row.
- Verify reassignment/cancellation receipts, membership/session revocation,
  tenant isolation and durable notification records.
- No provider delivery is required for the rehearsal. The disposable SQL and
  concurrency/rollback checks live under
  `scripts/security/rehearse-staff-offboarding-durable*`.

## 6. Routine production checks

- Keep Supabase leaked-password protection and email confirmation enabled.
- Verify Production never contains demo/test bypass environment variables.
- Review every new `SECURITY DEFINER` function and its explicit role grants.
- Run Supabase security advisors after migrations.
- Keep card-save edge and durable database rate limits enabled.
- Review runtime errors and cron operating-state freshness after each release.

## 7. 2026-09-16 release-order incident

PR #1411 added an application dependency on migration
`20260915143000_add_versioned_trial_entitlement_boundary.sql`. Vercel deployed
the merged `main` SHA before the migration was applied, so both live salon pages
failed closed and displayed booking paused. The exact migration was then applied
and recorded, and read-only database/browser canaries recovered both salons.

Root cause: the repository documented migration-first ordering but allowed
automatic Production deployment from `main`. Prevention: `main` Git deployment
is disabled and CI locks that setting plus this runbook sequence.

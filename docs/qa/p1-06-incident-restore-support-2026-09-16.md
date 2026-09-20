# P1-06 — Incident, restore and support acceptance

**Date:** 2026-09-16

**Branch:** `audit/p1-06-incident-restore-20260916`

**Base SHA:** `ff607477d47dbed15602ed7dcf9caeac087b87e9`

## Scope and evidence classes

This item covers V1-26, V1-27 and V1-29: production release/incident handling,
backup restore and staff offboarding. Results must be labelled separately as
existing before task, implemented locally, QA tested, Preview verified,
deployed and Production verified.

## Incident found during P1-05 release verification

- Production application `ff607477...` was READY before required migration
  `20260915143000` existed in the linked database.
- Both live public salon pages failed closed with booking paused.
- The reviewed migration was applied and recorded after explicit approval.
- Read-only DB probes then showed both salons `legacy` and accepting bookings;
  real-browser checks showed the booking form on both salons with no console
  error.
- Approximate exposure: 2026-09-16 06:09Z to 09:01Z. No affected-booking count
  was measured, so none is claimed.

## Existing before this task

- Disposable PostgreSQL logical backup/restore rehearsal with schema, row and
  application-contract fingerprints.
- Atomic durable staff offboarding SQL, sequence, concurrency and rollback
  rehearsals.
- Independent Production version/liveness/readiness monitor that opens or
  updates one GitHub incident and closes it after recovery.
- Error triage with explicit remediation states and approval-gated resolution.

## Implemented locally

- Disabled automatic Vercel Git deployment from `main`.
- Added a CI unit boundary that locks the deployment setting, incident drill
  wiring and schema-first runbook order.
- Replaced the stale go-live notes with an operational release/rollback,
  restore, offboarding and incident-support runbook.

## Required rehearsals

| Flow | Safe target | Acceptance evidence | Status |
|---|---|---|---|
| Backup → restore → compare → delete restore DB | Local disposable Supabase | Matching schema/data/contract fingerprints; restored DB removed | PASS LOCAL |
| Staff preview → atomic offboard → session/membership/assignment truth → rollback | Local disposable Supabase | SQL, sequence, race and rollback checks pass; no provider send | PASS LOCAL |
| Alert → configured recipient → handle → healthy close | GitHub manual monitoring drill | One synthetic incident opened/updated, recovery comment, closed issue | PASS QA |

## Local rehearsal evidence

### Release boundary and offboarding unit tests

- Vitest: 3 files, 20 tests passed.
- The new release-boundary suite verifies `main: false`, the manual incident
  workflow wiring, schema-first order and both rollback branches.
- Existing offboarding boundary suites verify owner/admin authorization,
  preview/completion and durable notification constraints.
- ESLint on the new boundary test passed with zero findings.
- Sequential TypeScript check and Next.js 16.3.4 production build passed; 61
  static pages generated. The first build invocation was discarded because
  Turbopack correctly rejected a shared `node_modules` symlink outside the
  worktree; the clean rerun used a local dependency directory.
- Full unit suite: 838 files passed, 6 skipped; 6,338 tests passed, 65 skipped.

### Staff offboarding on disposable PostgreSQL

All fixtures used reserved synthetic identities inside transactions. Outbound
workers/providers were not invoked.

- PASS atomic staff offboarding and durable `staff_change` outbox runtime.
- PASS sequence-aware assignment/capability/conflict recovery and active-write
  guard.
- PASS two-session replay plus booking/segment assignment race coordination.
- PASS mutation/outbox and schema rollback transactionality.

### Backup and restore on disposable PostgreSQL

The first attempt stopped safely because local `pg_dump` 16 did not match the
PostgreSQL 17.6 server. It was rerun with the installed PostgreSQL 17 client.

- Archive: 5,938,452 bytes.
- Relations checked: 295; rows checked: 826.
- Schema fingerprint:
  `e8a038c1860f537b463d61b071d48cadc9b6711b3a7625e1b0c4d758d2dba1de`.
- Data fingerprint:
  `dd75e0bbf443c841244cecbcdda4322d73e69e5f201df998689dd84b7847e3d8`.
- Application-contract fingerprint:
  `05c3e7804f05b5c7d8e192315a6e95f28ff95b469c122953ac426476c4db057d`.
- Result: `PASS_LOCAL`; the script's `finally` boundary drops the temporary
  restore database.

### Alert-to-recovery lifecycle

- Synthetic failure run:
  [35122584508](https://github.com/bepnhobencha-rgb/nailiq/actions/runs/35122584508)
  at candidate SHA `ff607477...`; probe failed only with the requested
  `simulated_monitor_failure` and the alert step succeeded.
- Incident recipient:
  [GitHub issue #1412](https://github.com/bepnhobencha-rgb/nailiq/issues/1412),
  created 2026-09-16T16:33:02Z with no customer data or secrets.
- Healthy recovery run:
  [35122651878](https://github.com/bepnhobencha-rgb/nailiq/actions/runs/35122651878);
  version, liveness and readiness passed and the close step succeeded.
- Issue #1412 received the recovery comment and closed as `COMPLETED` at
  2026-09-16T16:33:39Z.
- Direct post-drill probes returned one matching SHA `ff607477...`, health
  `ok`, readiness `ready`, database schema `ok` and cron authorization `ok`.
- No booking, salon/customer data, provider mutation, payment or outbound
  customer communication was involved.

## Rollback boundary

- Before publication: revert the local files; no remote effect.
- After release: `main: false` affects only automatic Git deployments. Manual
  Vercel deploy/promotion remains available. Re-enabling auto-deploy requires a
  reviewed `vercel.json` change and should not happen until a schema-aware
  release mechanism replaces this gate.
- No database migration is introduced by P1-06.

## Current verdict

Update 2026-09-20: the original publication status below is historical. The
candidate was committed/pushed as `9fe579aecb878391061a082bf6ab8223f3045415`
and is now PR #1413, OPEN, Ready for review and MERGEABLE. Executed CI checks
are SUCCESS; skipped checks are not acceptance evidence. Production still
serves base `ff607477...`, verified with matching version/health/readiness
probes at 2026-09-20T18:04:12.186Z. The three focused release/offboarding suites
were rerun: 20/20 passed. The deployment gate is therefore not deployed yet.
See [current Masterplan acceptance](MASTERPLAN_ACCEPTANCE_CURRENT.md) for the
consolidated acceptance queue and remaining operational gates.

**PASS LOCAL / PASS QA.** The incident is recovered; prevention, restore and
offboarding are PASS LOCAL, and the hosted synthetic alert lifecycle is PASS QA.
The local prevention change remains uncommitted/unpublished: Preview verified
NO, deployed NO, Production verified NO for the new `main` deployment gate.

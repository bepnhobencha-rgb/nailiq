# NailIQ migration-history reconciliation

**Audit date:** 2026-07-23  
**Release audited:** `4868e87d19621b48e55e0099a781a3915a9d47af` (`origin/main`)
**Supabase project:** `fshmobzyjhmtvndobwsy` (`NailIQOS`)  
**Status:** folded cutover deployed; production ledger repaired; strict parity verified

## Executive finding

The production schema is usable and the checked-in bootstrap can reproduce its
shape for E2E, but the migration ledger is not a deployable history.

The drift is much larger than the May 2026 runbook describes:

| Measure | Current result |
|---|---:|
| SQL files in `supabase/migrations` | 288 |
| Unique local version IDs | 264 |
| Production history rows | 266 |
| Exact version matches | 23 |
| Local-only unique versions | 241 |
| Production-only versions | 243 |
| Duplicate local version IDs | 20 |
| Extra files hidden behind duplicate IDs | 24 |
| Same migration name, different version | 192 production rows |
| Distinct local versions explained by those name matches | 179 |

This is not ordinary “a few migrations were applied manually” drift. Most of
the history was re-stamped: the semantic migration name matches, while the
version ID used by production differs from the filename committed to Git.
Running `db push` would therefore attempt to replay a large set of changes that
already exist.

The existing `npm run db:push` guard remains correct and must stay enabled until
the reconciliation is complete.

## Post-rehearsal correction

The first rehearsal PR proved the folding mechanism, but a full unit run during
cutover preparation caught that its generator appended only the final four
security migrations after the 2026-07-14 schema snapshot. That would have
omitted 22 other post-snapshot schema migrations from a fresh database,
including the first four public-booking security hardening migrations.

The cutover generator now deterministically reviews all 26 migrations introduced
after the snapshot and appends the 25 schema-bearing deltas. It intentionally
omits `20260722175728_move_cron_auth_to_vault.sql`: that migration is a
production-state credential transition over four existing `cron.job` rows and
has no schema effect, so it cannot run on a blank database. The generator also
removes exactly three top-level data statements: the private storage-bucket
configuration and two no-op-on-empty-database mapping backfills. The bucket
configuration moved to the idempotent non-PII reference seed. Function bodies
remain intact. The generated baseline now reports 89 tables and passes all 276
unit tests, including the eight public-booking security boundary assertions.
Because the schema snapshot deliberately removes `ALTER DEFAULT PRIVILEGES`,
the generator explicitly restores the production-equivalent `service_role`
grants on the two post-snapshot tables that inherited those defaults:
`owner_notification_log` and `sms_agent_sessions`.

Production was re-measured on 2026-07-23:

| Object | Production |
|---|---:|
| Public base tables | 89 |
| Public columns | 1,216 |
| RLS policies | 101 |
| App-owned public functions | 72 |
| Non-internal public triggers | 25 |
| Public indexes | 294 |
| Reachable objects for `anon` | 75 |
| Reachable objects for `authenticated` | 83 |
| Reachable objects for `service_role` | 94 |

## Duplicate local version IDs

Supabase tracks migrations by version ID, so multiple files with one version
cannot be represented independently in `schema_migrations`.

| Version | File count |
|---|---:|
| `20260430180000` | 2 |
| `20260430240000` | 2 |
| `20260524230000` | 2 |
| `20260607100000` | 2 |
| `20260607110000` | 2 |
| `20260609140000` | 2 |
| `20260615000000` | 2 |
| `20260615010000` | 2 |
| `20260615020000` | 3 |
| `20260615030000` | 3 |
| `20260615040000` | 2 |
| `20260617000000` | 2 |
| `20260618060000` | 2 |
| `20260618070000` | 2 |
| `20260618080000` | 2 |
| `20260618090000` | 2 |
| `20260618100000` | 3 |
| `20260618110000` | 3 |
| `20260618120000` | 2 |
| `20260620000000` | 2 |

## Why an in-place mass repair is rejected

Marking 241 local versions as applied would make the local filenames look
green, but it would not explain the 243 production-only rows or the 20 duplicate
IDs. Renaming hundreds of files to production timestamps would still leave the
repository without the original core-table creation history.

The safer target is a folded baseline:

1. Preserve the 266 production history versions as inert ledger markers.
2. Archive all 288 legacy local SQL files without deleting or rewriting Git
   history.
3. Build one deterministic baseline migration from the verified schema-only
   bootstrap plus the reviewed post-dump security deltas. Keep the non-PII
   lookup rows in the separate, idempotent reference-data seed so the migration
   itself remains provably schema-only.
4. Prove a blank Supabase Local database can apply that migration and pass the
   existing schema-parity, RLS, grant, seed, build and E2E gates.
5. Export the complete 266-row production migration ledger before any repair.
   It is about 299 KB; none of the rows currently has a rollback payload.
6. In a separately approved production window, mark only the new folded
   baseline version as applied. Do not execute its schema SQL on production.
7. Verify `migration list`, schema shape, grants, RLS and production smoke
   before removing the `db:push` guard.

Keeping the existing production marker rows avoids throwing away historical
evidence and makes rollback of the ledger edit a single-row operation.

## Rehearsal gates

The reconciliation is not eligible for production until all of these are
proven on a throwaway local/CI database:

- [x] Generated baseline contains no customer rows and no credential-shaped
  values.
- [x] Migration versions are unique.
- [x] Blank database applies the corrected 25-schema-delta history from zero.
- [x] Tables, columns, policies, functions, triggers and indexes meet the
  production parity assertions.
- [x] Grant matrix matches production exactly.
- [x] RLS is enabled on every core table.
- [x] Seed is idempotent.
- [x] Typecheck, unit, build and both E2E suites pass on one exact SHA.
- [x] Ledger rollback procedure restores the pre-repair version set.
- [x] `db:push` remained blocked through production verification.

## Production boundary

The owner explicitly approved production migration-history repair on
2026-07-23 after the rehearsal was green and rollback was available.

Before preparing the cutover, the complete six-column ledger was copied
transactionally to
`supabase_migrations.schema_migrations_backup_20260723_pre_folded_cutover`.
Both the source and backup contain 266 rows and have ledger checksum
`b3f3f1be0c17619986bb0ac37f2aa3ad`. A transaction-scoped restore rehearsal
copied the backup into a table with the production shape and reproduced the
same row count and checksum before rolling back.

The repository cutover archived the 288 legacy SQL files under
`supabase/migration-history/legacy-2026-07-23/`, checks in 266 inert markers
plus the folded baseline, and kept `db:push` blocked. PR #912 passed build,
security, smoke, both E2E suites, and the blank-Supabase migration rehearsal,
then deployed to Vercel production as
`4868e87d19621b48e55e0099a781a3915a9d47af`.

Production then recorded only baseline version `20260723000000` as applied in a
transaction guarded by the 266-row backup and exact schema/grant/RLS
preconditions. Its schema SQL was not executed. Independent post-commit
verification found 267 ledger rows, exactly one folded-baseline marker, the
unchanged object counts (89 tables, 1216 columns, 101 policies, 72 app
functions, 25 triggers, 294 indexes), unchanged reachable-table grants
(anon 75, authenticated 83, service_role 94), and RLS enabled on every core
table. The 266-row rollback backup remains in place.

## Relevant current Supabase behavior

Supabase compares migration files with
`supabase_migrations.schema_migrations`; `migration repair` changes only that
tracking table and does not execute or revert migration SQL. Supabase also plans
to require explicit Data API grants for new tables on existing projects from
2026-10-30, so the folded baseline must preserve and test grants rather than
depending on historical defaults.

# NailIQ migration-history reconciliation

**Audit date:** 2026-07-23  
**Release audited:** `b2e379b0f26f7e8007657ddbf986f5ed30dc1be2` (`origin/main`)  
**Supabase project:** `fshmobzyjhmtvndobwsy` (`NailIQOS`)  
**Status:** rehearsal design only; production unchanged

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

- [ ] Generated baseline contains no customer rows and no credential-shaped
  values.
- [ ] Migration versions are unique.
- [ ] Blank database applies the history from zero.
- [ ] Tables, columns, policies, functions, triggers and indexes meet the
  production parity assertions.
- [ ] Grant matrix matches production exactly.
- [ ] RLS is enabled on every core table.
- [ ] Seed is idempotent.
- [ ] Typecheck, unit, build and both E2E suites pass on one exact SHA.
- [ ] Ledger rollback procedure restores the pre-repair version set.
- [ ] `db:push` remains blocked until production verification succeeds.

## Production boundary

No production repair, schema migration, data write, branch purchase, backup
restore or destructive operation is authorized by this document. The local/CI
rehearsal can proceed independently; editing the production migration ledger
requires explicit owner approval after the rehearsal evidence is green.

## Relevant current Supabase behavior

Supabase compares migration files with
`supabase_migrations.schema_migrations`; `migration repair` changes only that
tracking table and does not execute or revert migration SQL. Supabase also plans
to require explicit Data API grants for new tables on existing projects from
2026-10-30, so the folded baseline must preserve and test grants rather than
depending on historical defaults.

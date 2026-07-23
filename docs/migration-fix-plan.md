# Migration Tracking Reconciliation — Resume Plan

> Tracks audit finding **C-2** (`docs/audit-2026-05-04.md`).
> Source of truth for the diagnosis is `docs/decisions.md` → "Migration tracking out of sync".
> This file is the executable runbook; `decisions.md` is the architectural log to update at the end.
>
> **Completed 2026-07-23.** This file preserves the original plan for audit
> history. PR #912 cut over to a folded baseline, production recorded only its
> history marker after a rollback rehearsal, and PR #913 locked strict 267/267
> parity. Do not repeat the repair steps below.

## TL;DR

13 local migration files exist on disk under `supabase/migrations/`. Their schema is already present on prod (E2E green proves this) but the remote `supabase_migrations.schema_migrations` tracking table never recorded them — almost certainly because they were applied via the dashboard SQL editor or by a `db push` that died before updating tracking.

Plus one stale remote row (`20260428`) for the pre-rename id of `register_completion_tokens.sql`. Today's commit `7de1124` renamed the file to `20260428130000_register_completion_tokens.sql`; remote still tracks the old id.

We do **not** want to re-run the SQL. We want `supabase migration repair` to mark the rows correct.

`npm run db:push` now uses `scripts/db-push-safe.mjs`. Its default behavior is
read-only: deploy-ready history audit followed by `supabase db push
--dry-run --linked` using pinned CLI 2.109.1. A real apply requires the explicit
`--apply` flag and the approval value documented by the script.

## Prereqs (5-minute warm-up)

Run these from the repo root in the order shown. Each should succeed before you continue.

```sh
# 1. CLI present
npx supabase --version
# Expect a version string. If "command not found", install: brew install supabase/tap/supabase

# 2. CLI linked to the prod project
npx supabase projects list
# Expect a row marked "linked" with ref fshmobzyjhmtvndobwsy. If not linked:
#   npx supabase login
#   npx supabase link --project-ref fshmobzyjhmtvndobwsy

# 3. Confirm we're on the right branch with a clean tree
git status
# Expect: On branch yolo-mode, working tree clean.

# 4. Sanity: the 24 migrations are still on disk
ls supabase/migrations/ | wc -l
# Expect: 24

# 5. Snapshot the current drift (will be your "before" reference)
npx supabase migration list 2>&1 | tee /tmp/migration-list-before.txt
# Expect: ~13 rows where Local has a value but Remote is empty,
# plus one row where Remote=20260428 with no Local match.
# Save this file — you'll diff against it after step 4.
```

If any of these fail, **stop and resolve the prereq first.** The reconciliation steps assume all five pass.

## Step 1 — Backup prod

A logical dump is the only safety net. Take it before touching the tracking table.

```sh
mkdir -p backups
npx supabase db dump --linked > "backups/nailiqos-pre-reconcile-$(date +%Y%m%d-%H%M).sql"
```

Verify the dump is real:

```sh
ls -lh backups/
# Expect a file > 50 KB (schema is non-trivial).

grep -c "^CREATE " backups/nailiqos-pre-reconcile-*.sql
# Expect a number in the dozens (CREATE TABLE / CREATE INDEX / CREATE POLICY rows).

grep -c "^CREATE TABLE.*public\.bookings" backups/nailiqos-pre-reconcile-*.sql
# Expect 1 (the bookings table is the canary — if it's missing, the dump didn't capture data and you should retry).
```

Add `backups/` to `.gitignore` *before* moving on, so the dump can't be accidentally committed:

```sh
grep -q "^backups/" .gitignore || printf '\nbackups/\n' >> .gitignore
git diff .gitignore   # eyeball the change
git add .gitignore
git commit -m "chore: gitignore backups/ before migration reconcile"
```

(Do not push yet — keep one local commit at this point in case anything goes wrong.)

## Step 2 — Verify each schema is actually on prod

For every timestamp listed below, before marking it "applied" you need to *eyeball-confirm* that the schema it claims to install is present on prod. Tracking-table edits are cheap to undo, but marking something applied that was never actually applied means a future migration will silently no-op past it. That's the failure mode we are buying insurance against here — don't skip this step.

Open the Supabase dashboard for project `fshmobzyjhmtvndobwsy` → SQL editor. For each timestamp, run the matching probe and check the expected result.

| Timestamp | File | Probe SQL | Expected |
|---|---|---|---|
| `20260430180000` | `client_profiles.sql` + `public_booking_occupancy_rpc.sql` (two files share the timestamp; both must be present) | `select to_regclass('public.client_profiles'); select to_regprocedure('public.public_booking_occupancy_for_range(uuid, timestamptz, timestamptz)');` | both non-null |
| `20260430210000` | `salons_booking_closed_dates.sql` | `select column_name from information_schema.columns where table_name='salons' and column_name='booking_closed_dates';` | one row |
| `20260430220000` | `realtime_bookings_publication.sql` | `select pubname from pg_publication where pubname='supabase_realtime'; select schemaname, tablename from pg_publication_tables where tablename='bookings';` | publication exists, bookings is a member |
| `20260430230000` | `bookings_no_overlap_gist.sql` | `select conname from pg_constraint where conname='bookings_no_overlap';` | one row |
| `20260430240000` | `create_public_booking_atomic_json.sql` + `salon_slug_similarity_rpc.sql` (two files share the timestamp) | `select to_regprocedure('public.create_public_booking(uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text)'); select to_regprocedure('public.salon_slug_similarity(text)');` | both non-null. Note: actual function arg-list may differ; check `\df public.create_public_booking` to confirm one definition exists. |
| `20260430250000` | `create_public_booking_business_rules.sql` | confirm `create_public_booking` raises a business-rules error path: `\df+ public.create_public_booking` and grep the body for `salon not_open` or similar. | function body contains the new validation block |
| `20260430260000` | `normalize_salons_nanp_phone_digits.sql` | `select count(*) from salons where phone ~ '^\+1' and length(regexp_replace(phone,'\D','','g'))<>11;` | 0 (data already normalized) |
| `20260502120000` | `receptionist_center_schema.sql` | `select is_nullable from information_schema.columns where table_name='bookings' and column_name='start_time_utc';` | `YES` |
| `20260502130000` | `public_booking_conflict_check.sql` | `\df+ public.create_public_booking` and confirm the v2.3 conflict-check block is present. | yes |
| `20260503140000` | `create_public_booking_salon_timezone_hours.sql` | `\df+ public.create_public_booking` and confirm the salon-timezone-hours v2.4 block is present. | yes |
| `20260503210000` | `bookings_client_name_check.sql` | `select conname, convalidated from pg_constraint where conname='bookings_client_name_safe';` | one row, `convalidated=false` (NOT VALID — that's expected; see audit L-3) |

If any probe returns the unexpected result, **stop**. That migration was *not* in fact applied on prod. You need to apply it explicitly (via dashboard SQL editor, copying the file's contents) **before** marking it applied via repair. Do that for that one migration only, then continue.

Once every row above is verified, move on.

## Step 3 — Repair the 11 unrecorded timestamps

These are pure tracking-table writes. They do not run any of the migration SQL.

```sh
npx supabase migration repair --status applied 20260430180000
npx supabase migration repair --status applied 20260430210000
npx supabase migration repair --status applied 20260430220000
npx supabase migration repair --status applied 20260430230000
npx supabase migration repair --status applied 20260430240000
npx supabase migration repair --status applied 20260430250000
npx supabase migration repair --status applied 20260430260000
npx supabase migration repair --status applied 20260502120000
npx supabase migration repair --status applied 20260502130000
npx supabase migration repair --status applied 20260503140000
npx supabase migration repair --status applied 20260503210000
```

Each prints something like `Repaired migration history: 20260430180000 => applied`.

Note: `20260430240000` is one timestamp shared by two files (`create_public_booking_atomic_json.sql` and `salon_slug_similarity_rpc.sql`). The CLI tracks by id, so a single repair entry covers both. After this whole reconciliation is done, rename one of those files to a unique timestamp (e.g. `20260430241000_salon_slug_similarity_rpc.sql`) — see audit L-2.

## Step 4 — Repair the rename

```sh
npx supabase migration repair --status reverted 20260428
npx supabase migration repair --status applied 20260428130000
```

The first call clears the stale remote row that points at the pre-rename id. The second records the post-rename id.

## Step 5 — Verify

```sh
npx supabase migration list 2>&1 | tee /tmp/migration-list-after.txt
```

Expect: every Local row has a matching Remote row. No orphans on either side.

Compare against the snapshot from prereqs:

```sh
diff /tmp/migration-list-before.txt /tmp/migration-list-after.txt
```

Then run a structural diff:

```sh
npx supabase db diff --linked
```

Expect: empty output. If the diff is non-empty, prod schema differs from the local migration files in some way the tracking table doesn't capture. **Stop.** Investigate before unblocking; common causes are (a) an ad-hoc dashboard change that was never written to a migration file, or (b) a probe in step 2 you marked "yes" that was actually a partial application. Resolve before continuing.

## Step 6 — Validate end-to-end

Trigger the E2E workflow on the branch you just reconciled (or main if you've already merged):

```sh
gh workflow run e2e.yml --ref yolo-mode
gh run watch
```

Wait for green. If it fails with schema-related errors (`relation does not exist`, `function does not exist`, `column does not exist`), the assumption "schema is fully present on prod" was wrong — at least one local migration was never actually applied. Identify which from the failure log, apply that one only via the dashboard SQL editor, then re-run step 5.

If E2E is green, the reconciliation is complete.

## Step 7 — Unblock `db:push`

Replace the guard with the real command:

```sh
# Edit package.json
#   "db:push": "node scripts/db-push-guard.js"
# becomes
#   "db:push": "supabase db push"
```

Then delete the guard:

```sh
git rm scripts/db-push-guard.js
```

Quick smoke test that the unblocked command sees no work to do:

```sh
npm run db:push
# Expect: "Remote database is up to date." (or equivalent — no SQL executed.)
```

## Step 8 — Update the architectural log

Edit `docs/decisions.md`:

- Change the entry's **Status** line from `Open. No reconciliation yet performed.` to `Resolved.`
- Append at the bottom of that entry: `Reconciled on YYYY-MM-DD via commit <hash>.`

Edit `docs/audit-2026-05-04.md`:

- Strike through or remove the C-2 row from the Critical table.
- Decrement the issue count in the "Issue counts" footer (Critical: 3 → 2; Total: 31 → 30).

Commit:

```sh
git add package.json scripts/db-push-guard.js docs/decisions.md docs/audit-2026-05-04.md
git commit -m "chore(db): unblock db push after migration tracking reconcile"
git push origin yolo-mode
```

## Rollback

If anything goes sideways during step 3 or 4:

- Tracking-table writes are individually reversible. To undo a single repair:
  - to undo `--status applied <ts>`: `npx supabase migration repair --status reverted <ts>`
  - to undo `--status reverted <ts>`: `npx supabase migration repair --status applied <ts>`
- The dump from step 1 is the schema escape hatch. Restore via:
  ```sh
  # WORST-CASE only — requires direct db url and will overwrite prod.
  # Do NOT run this without a second pair of eyes.
  psql "<prod-connection-string>" < backups/nailiqos-pre-reconcile-*.sql
  ```
  In practice you'll never need this; the repair commands don't touch real schema.

## What's safe to skip

- The `20260428` revert in step 4 is technically optional — if you skip it, `migration list` will continue to show one orphan remote row forever. It costs nothing to fix it, and skipping confuses the next person who runs `migration list`.
- Step 6 (E2E run) can be deferred to the next push, but doing it inline gives you fast confirmation that nothing is silently broken.

## What's NOT safe to skip

- Step 1 (backup). Always.
- Step 2 (probe each schema). Marking something "applied" that wasn't is the failure mode that makes everything downstream worse.
- Step 5 verification (`db diff` empty). The whole point is to land in a clean tracking state.

## Time budget

- Prereqs: 5 min.
- Step 1: 2 min.
- Step 2: 15–20 min (the slow, careful one).
- Step 3 + 4: 2 min.
- Step 5: 2 min.
- Step 6: 5–10 min depending on E2E queue.
- Step 7 + 8: 5 min.

Plan ~45 minutes uninterrupted. Don't try to do this in a window narrower than 30.

## Open questions to settle before starting

- Are you OK with the dump landing in `backups/` (gitignored), or do you want it in an external location (1Password, S3, etc.)?
- Is anyone else likely to push a new migration before you finish? If yes, coordinate first — a new file landing during reconciliation will require an extra `repair --status applied` for it.

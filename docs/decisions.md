# Architectural Decisions

This file logs significant architectural and operational decisions for nailiq.
Newest entries on top.

---

## 2026-05-06 — Demo registration is restricted to a single shared `demo-salon`

**Status.** Resolved by PR #16 (`cd4a948`).

**Context.** The demo-cookie security guard (originally added in PR #4, then rolled back because it broke real owners with non-`demo-salon` slugs) only trusts the `demo-salon` slug. Without a companion fix, demo-mode registrations could create salons at any name-derived slug — and `pickAvailableSalonSlug` would happily suffix `demo-salon-2`, `demo-salon-3`, etc. once the canonical slug was taken — making the cookie guard impossible to re-introduce safely. Tracked across multiple sessions as the "companion fix" backlog item.

**Decision.** Demo mode is restricted to a single shared salon at the constant `DEMO_SALON_SLUG` (= `"demo-salon"`). Production behavior is unchanged because `isDemoOtpRuntime()` returns `false` whenever `DEMO_OTP=false` (or unset with `NODE_ENV=production`).

**Implementation.**

1. **Slug picker (`src/shared/register/salonSlugPicker.ts`).** `pickAvailableSalonSlug` short-circuits to `{ slug: DEMO_SALON_SLUG, slugAdjusted: false }` whenever `isDemoOtpRuntime()` is true. The DB uniqueness search and `-2`/`-3` candidate loop are skipped entirely. Caller-supplied salon names are ignored under demo mode.

2. **Server action (`src/shared/register/completeSalonRegistrationAction.ts`).** The demo branch checks for an existing `demo-salon` salon row before insert. If present (i.e. created on a prior demo registration; all demo users share a single demo owner via `getOrCreateDemoSalonOwnerUserId`), the salon/services/staff/salon_members inserts are skipped — only the completion-token delete and the demo cookie set still happen, then the action returns the existing slug. This is what makes a second-and-onward demo registration succeed without tripping the `salons.slug` unique constraint.

3. **Client component (`src/app/register/setup/RegisterSetupInner.tsx`).** Accepts a server-resolved `isDemoMode` boolean prop, threaded through `page.tsx`. In demo mode the salon-name input is pre-filled with "Demo Salon" (which slugifies to `demo-salon`), set `readOnly`, the slug preview is overridden to `DEMO_SALON_SLUG`, and the existing copy is replaced with: *"Demo mode uses shared salon: demo-salon. The name and slug aren't configurable in this build."* Server action remains authoritative — bypassing the `readOnly` attribute still results in slug `demo-salon` because the picker forces it.

**Hydration safety.** `isDemoMode` is resolved server-side in `page.tsx` via `isDemoOtpRuntime()` and passed as a prop to the client component. Calling `isDemoOtpRuntime()` directly inside the client would risk a server/client mismatch when only the server-only `DEMO_OTP` is set without `NEXT_PUBLIC_DEMO_OTP` — the prop pattern eliminates that ambiguity.

**Production inertness.** All four added code paths are gated behind `isDemoOtpRuntime()`. With `DEMO_OTP=false` (or unset) on Vercel, none of them execute — production registration still derives slugs from the salon name with the same `-2`/`-3` collision suffixing as before.

**Follow-up (separate PR, deferred).** Re-introduce the demo-cookie scope guard rolled back in PR #4. The `slug === DEMO_SALON_SLUG` check is now safe because demo registrations cannot drift to any other slug. Track in a future "security: re-add demo cookie scope guard" PR — it should be a minimal revert-of-the-revert plus an updated comment in `middleware.ts` linking to this entry.

**Related.** Commits `cd4a948` (merge), `0b54d01` (commit). PRs #4 (rolled-back guard), #16 (this fix). Constants: `DEMO_SALON_SLUG` in `src/shared/lib/demoOtpMode.ts`.

---

## 2026-05-04 — Migration tracking out of sync; `db push` blocked until reconciled

**Status.** Open. No reconciliation yet performed.

**Context.** nailiq runs against a single Supabase project (`nailiqOS`, ref `fshmobzyjhmtvndobwsy`). There is no separate test project — E2E and production share the DB. On 2026-05-04 we ran `npx supabase migration list` and discovered significant drift between local migration files and the remote `supabase_migrations.schema_migrations` tracking table.

**Findings.**

- 13 local migration files are **not recorded** as applied on the remote tracking table — but E2E tests (run #21) pass, so the schema *is* present on prod. Most likely applied via the dashboard SQL editor or by earlier `db push` runs that did not update tracking.
- 1 remote-only stale entry: `20260428`. This is the pre-rename id of `register_completion_tokens.sql`. Today's commit `7de1124` renamed the file to `20260428130000_register_completion_tokens.sql`; remote still tracks the old id.

The 13 local-only entries:

- `20260428130000_register_completion_tokens` (this is the rename)
- `20260430180000_*` (one of two duplicate-timestamp files; see note in step 2)
- `20260430210000`, `20260430220000`, `20260430230000`
- `20260430240000` (×2 files, same id — see step 2 note)
- `20260430250000`, `20260430260000`
- `20260502120000`, `20260502130000`
- `20260503140000`, `20260503210000`

**Risk.** Running `npx supabase db push` now would attempt to re-execute the SQL for all 13 entries — including `CREATE TABLE` and similar statements for objects that already exist on prod. Likely partial-transaction failures, possibly destructive depending on how each migration is written.

**Decision.**

1. Block `npm run db:push` with a guard script (`scripts/db-push-guard.js`) that exits non-zero with a pointer to this entry. Direct `npx supabase db push` calls remain technically possible — the guard is convention, not enforcement — but it stops accidental `npm run` invocations.
2. Reconcile via `supabase migration repair`, **not** by re-running SQL.
3. Only after reconciliation, replace the guard with the real command.

**Reconcile plan.**

### 1. Backup

Take a logical dump of prod before touching the tracking table.

```
mkdir -p backups
npx supabase db dump --linked > backups/nailiqos-pre-reconcile-$(date +%Y%m%d-%H%M).sql
```

Verify the file is non-empty and contains recent table definitions (`grep -c CREATE backups/nailiqos-pre-reconcile-*.sql`). Keep the dump out of git (already covered by `.gitignore` patterns; verify before committing anything else).

### 2. Repair the 12 truly-applied entries

For each timestamp below, first verify the corresponding schema is in fact present on prod (Table Editor or `\d <table>` via the SQL editor in the Supabase dashboard). Then mark applied without re-running:

```
npx supabase migration repair --status applied <timestamp>
```

Repeat for: `20260430180000`, `20260430210000`, `20260430220000`, `20260430230000`, `20260430240000`, `20260430250000`, `20260430260000`, `20260502120000`, `20260502130000`, `20260503140000`, `20260503210000`.

That is 11 distinct timestamps covering 12 files (the two `20260430240000` files share an id). The rename (`20260428130000`) is handled separately in step 3.

*Duplicate-timestamp note.* The CLI tracks by id, so only one row is needed in the tracking table per id. The two `20260430240000` files will both appear "applied" via the single repair entry. Going forward, avoid creating two migrations with the same timestamp — the apply order between them is filesystem-dependent.

### 3. Repair the rename

```
npx supabase migration repair --status reverted 20260428
npx supabase migration repair --status applied 20260428130000
```

### 4. Verify

```
npx supabase migration list
```

Expect: every Local row has a matching Remote row; no orphans on either side.

```
npx supabase db diff --linked
```

Expect: empty diff. If non-empty, prod schema differs from local files in some way the tracking table doesn't capture — investigate before proceeding.

### 5. Test

Trigger the E2E workflow on `main`:

```
gh workflow run e2e.yml
```

Wait for green. If it fails with schema-related errors, the assumption that "schema is fully present on prod" was wrong — at least one local migration was never actually applied. Stop, identify which, and apply only that one via `db push --include-all=false` with explicit selection (or run the SQL manually via the dashboard editor) before re-running step 4.

### 6. Unblock

Replace the guard with the real command in `package.json`:

```json
"db:push": "supabase db push"
```

Commit. Update this entry: change **Status** to **Resolved**, append `Reconciled on YYYY-MM-DD via commit <hash>.`

**Related.** Commits `7de1124` (rename that exposed the drift), `06e9463` (CI env vars), `a381d92` (Edit perms scope). Discovery from `npx supabase migration list` output captured in chat on 2026-05-04.

---

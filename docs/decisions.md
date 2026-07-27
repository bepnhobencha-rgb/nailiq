# Architectural Decisions

This file logs significant architectural and operational decisions for nailiq.
Newest entries on top.

---

## 2026-07-27 — Owners can recover failed AI work without bypassing execution safety

**Status.** Implemented on `agent/ai-execution-recovery`.

**Context.** AI Control Center accurately exposed queued, failed, and stalled
work, but an owner could not resolve a failed or no-longer-wanted job from the
same operating surface. Recovery required database intervention, so the control
center was observability without operational control.

**Decision.**
- Owners/admins may retry only a `failed` job that remains below its bounded
  attempt limit. Retry returns it to `queued`; the worker still owns execution.
- Owners/admins may cancel `queued`, `waiting_input`, or `failed` work. Running
  work cannot be canceled because its external effect may already have started;
  succeeded/canceled states remain terminal.
- A service-role-only, security-invoker RPC locks the tenant-scoped job and
  writes its transition plus `ai_actions_log` row in one database transaction.
  Public, anonymous, and authenticated Data API roles cannot execute the RPC.
- The Server Action independently resolves the salon and verifies owner/admin
  membership before calling the RPC. Stale UI actions return `invalid_state`
  rather than overwriting a concurrent worker transition.
- Retry/cancel adds no new sender, payment, pricing, authentication, or campaign
  authority.

---

## 2026-07-27 — AI operating state must be measured, tenant-scoped, and honest

**Status.** Implemented on `agent/ai-operating-health`.

**Context.** AI Control Center showed recent jobs, but owners could not tell
whether the execution system was healthy, actively working, waiting for safe
input, or carrying a hidden failure. Learned cooldowns and outcome-based pace
reductions altered behavior without an owner-facing explanation.

**Decision.**
- Queue health uses exact, salon-scoped counts for queued, waiting-input,
  running, and failed jobs. A running lease older than the worker's 15-minute
  recovery threshold is explicitly reported as stalled.
- Status severity is deterministic: failed/stalled → issue; waiting input →
  attention; queued/running → active; otherwise healthy. A failed job is never
  presented as completed or silently omitted.
- Owner-facing learned controls include only active lessons belonging to that
  salon. Global and cross-salon lessons are excluded, and expired proposal
  cooldowns are filtered at read time.
- The surface explains temporary proposal cooldowns and bounded contact-cap
  reductions. It is read-only and adds no execution, messaging, payment, or
  authentication authority.

---

## 2026-07-27 — Owner decisions must alter proposal frequency without permanently muting AI

**Status.** Implemented on `agent/approval-preference-learning`.

**Context.** A declined approval created a new `policy` lesson, but the weekly
strategist never read policy lessons. The system therefore claimed to learn while
repeating the same approval pattern. Creating one permanent suppression lesson
per decline would overreact to a single decision and could never recover.

**Decision.**
- Resolved weekly-strategist approvals are evaluated inside the same salon,
  action type, and proposal source. Unrelated bulk-message workflows cannot
  teach this policy.
- Two declines among the latest three resolved decisions activate one
  deterministic `proposal_cooldown` lesson for 28 days. Fewer than three
  decisions do not change behavior.
- Two consecutive approvals recover the learned cooldown. The gap between
  activation and recovery is deliberate hysteresis.
- During an active cooldown, strategist analysis and read-only recommendations
  may still run, but no repeated approval request is created. The suppression is
  written to `ai_actions_log` with its lesson and expiry.
- The expiry is enforced at read time, so a stale lesson cannot permanently mute
  proposals even if a cleanup cron is delayed.
- This mechanism only removes future proposals. It adds no sender, execution
  permission, payment behavior, or authentication authority.

---

## 2026-07-27 — Outcome adaptation must change behavior, stay bounded, and recover

**Status.** Implemented on `agent/ai-outcome-adaptation`.

**Context.** The learning cron aggregated conversion outcomes, but the result did
not reliably affect agent behavior. Newly sent actions omitted `payload.phone`,
so the outcome tracker could not associate them with later bookings. The old
analysis also reduced confidence on broad lessons that were not necessarily
owned by the low-performing agent.

**Decision.**
- Every trackable customer action records the canonical customer phone in its
  audit payload. Historical rows recover phone from `winback_suggestions`,
  `first_visit_sequences`, or `client_profiles` using tenant-scoped batch reads.
- A 30-day sample of at least 10 resolved actions activates an agent-specific
  `segment` lesson below 5% conversion. The lesson applies
  `cap_multiplier:0.5`; a 10% recovery threshold deactivates it. The 5–10% gap
  provides hysteresis.
- Learned caps are bounded to 25–100% of the code cap and may never raise a cap
  or stop an agent entirely. Winback, rebook, first-visit nudges, and VIP Care
  all consume the same helper.
- The adaptive lesson uses a deterministic UUID and primary-key upsert, making
  concurrent cron retries idempotent. Audit rows are written only when the
  active state actually changes.
- No sender, channel permission, campaign authorization, pricing behavior, or
  payment behavior is added by this loop.

---

## 2026-06-19 — Minh Learning Loop Bước 3: approval_requests + owner notification (§3D + §3E)

**Status.** Migration applied to prod (`fshmobzyjhmtvndobwsy`). Code in `feat/minh-approval-requests`.

**Context.** Per SPEC §3D-3E. "Không để việc chờ duyệt nằm im" — urgent actions email owner immediately with one-tap approve/decline; normal ones batched into 21:00 digest.

**Decision.** `approval_requests` table (urgency/approve_token/decline_token/expires_at); `/api/ai/approve?token=...` for no-login decision; dashboard `/approvals` page; declined → lesson `policy` scope with confidence 0.7.

- **Token auth:** each row has two opaque 64-hex tokens (approve / decline). Knowing the token IS the authorization — no login required. Tokens are single-use (status flips to approved/declined immediately).
- **Expiry:** urgent defaults 4h, normal 48h. Cron `minh-learn` marks expired rows + sends one reminder after 24h.
- **Learning loop:** a decline auto-creates a `minh_lessons` entry (`scope=policy`) so Minh reduces proposals of that action type.
- **Digest integration:** normal-urgency pending approvals appear in the 21:00 digest email with inline one-tap buttons (same token URLs).

---

## 2026-06-19 — Minh Learning Loop Bước 2: feedback signals (channel failures + outcomes)

**Status.** Code in `feat/minh-feedback-loop`.

**Context.** Per `SPEC-minh-learning-loop §3B`. Closes the loop: Twilio failure rates and agent conversion outcomes now flow back into `minh_lessons` automatically.

**Decision.**
- `analyzeChannelFailures()`: queries `booking_notifications` for a salon's last 7d SMS sends. If fail rate >50% and sample ≥5, auto-creates a `channel` lesson (`prefer_email`). Uses error codes 30034/30007 (A2P carrier rejection) as additional failure signals. Idempotent — skips if an active lesson already exists.
- `analyzeAgentOutcomes()`: reads `ai_actions_log` outcomes for last 30d. Agents with <5% conversion rate (min 10 resolved actions) trigger a `decreaseLessonConfidence()` call (delta 0.05) on any `timing`/`channel`/`segment` lessons scoped to them. Minor delta by design — needs sustained poor performance to deactivate.
- `lessonMutations.ts`: `createLesson` / `decreaseLessonConfidence` / `deactivateLesson` helpers. Lessons auto-deactivate when confidence drops below 0.2. Source field preserves deactivation reason for audit trail.
- `channelCostTracker.ts`: per-channel cost accumulator (SMS ~$0.0079, email ~$0.001) — feeds digest in a future step.
- Both analysers run in daily cron `/api/cron/minh-learn` at 03:00 UTC. Summary logged to `ai_actions_log` when lessons change.
- Code guardrails in `channelResolver.ts` remain as backstop.

---

## 2026-06-19 — minh_lessons: lesson store for AI learning loop (Bước 1)

**Status.** Migration applied to prod. Code in `feat/minh-lessons`.

**Context.** Per `SPEC-minh-learning-loop §3A`. Converts hardcoded guardrails into DB records that agents read before acting, enabling runtime rule changes without deploys.

**Decision.** `minh_lessons` table (scope/condition jsonb/rule/confidence) + `getLessons()` + `findChannelLesson()`. Agents call `getLessons()` first then fall through to code guardrails as backup. Lesson #1 (A2P) seeded as the canonical example. `agentWinback` wired as proof-of-concept: reads channel lessons once per run, logs `lesson_id` when a lesson blocks SMS for a candidate.

---

## 2026-06-19 — A2P guardrail: US SMS auto-routes to email until registered (Minh lesson #1)

**Status.** Code in PR `fix/minh-a2p-sms-guardrail` (draft). Stopgap live: Hi-Lite `sms_outbound_enabled` set FALSE via Supabase MCP on 2026-06-19.

**Context.** Live QA found the AI Manager ("Minh") winback agent sent **13 real SMS** to US customers for `hilite-anaheim`, a salon with `sms_a2p_registered = false`. US A2P 10DLC unregistered SMS is silently carrier-dropped and can still incur Twilio fees. The system *recorded* `sms_a2p_registered = false` but **did not act on it** — routing used only the manual `sms_outbound_enabled` flag (default TRUE), which nobody had flipped. `channelResolver.ts` explicitly noted the A2P flag "does NOT control routing." Net: Minh measured outcomes but had no feedback loop to stop a known-bad channel — it would repeat for the next US salon.

**Decision.** Wire the compliance flag into routing so the system self-protects:
- `resolveCustomerChannel` gains optional `smsA2pRegistered` + `customerPhone` (default to pre-guardrail behaviour → existing callers unchanged). When the destination is a **US** number (`isUsPhone`, new `src/shared/lib/phoneRegion.ts`) **and** `smsA2pRegistered === false`, SMS is treated as unavailable → smart mode falls back to email (`email_a2p_fallback`).
- Non-US numbers (CA/VN/etc.) and A2P-registered salons are unaffected.
- Wired into `agentWinback` first (the agent that fired). **Follow-up:** wire the same params into `agentFirstVisit`, `agentRebook`, `vip_care`, reminders, `sendReviewRequest` (tracked in `docs/SPEC-minh-learning-loop.md`).

**Why this is "lesson #1".** It is the first concrete instance of turning an incident into a durable, system-enforced rule rather than a one-off manual fix — the seed of the Minh learning loop (see SPEC). One incident → one guardrail that can never silently repeat.

**Verification.** `npm run typecheck` green. Preview-first (cost/customer path): merge after PM review. Check Twilio Console messaging logs (17–18/06) for the 13 sends' error codes (30034 = blocked) + price.

---

## 2026-06-19 — Duplicate booking-confirmation emails + wrong salon name

**Status.** Code in PR `fix/duplicate-confirmation-email` (draft). Migration index `booking_notifications_confirmation_once` applied to prod via Supabase MCP.

**Context.** Live booking on `hilite-anaheim` produced **2 identical confirmation emails** (1s apart), both titled with the slug `hilite-anaheim` instead of "Hi-Lite Head Spa". Root cause: `sendBookingConfirmationEmail` selected a non-existent `currency` column (real: `currency_code`) → salon lookup errored → `salonRow = null` → (a) the email notification log was skipped, defeating the `/api/booking/sms-confirm` dedup guard (which counts email rows) so both it and `publicBookingSideEffects` sent; (b) the email fell back to slug name / Vancouver tz / CAD.

**Decision.** `currency` → `currency_code`; plus a race-proof claim-before-send (`claimNotificationOnce` + partial unique index on `(booking_id, channel) where notification_type='booking_confirmation'`). First sender wins, the other skips.

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

**Status.** Resolved on 2026-07-23 by PRs #912 and #913.

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

### 6. Unblock safely

The historical plan to replace the guard with a raw `supabase db push` command
was superseded. `npm run db:push` now runs a pinned CLI through
`scripts/db-push-safe.mjs`: it first proves the local history is an exact
extension of the audited production ledger, always performs a linked dry-run,
and changes production only when both `--apply` and
`NAILIQ_DB_PUSH_APPROVAL=APPLY_REHEARSED_MIGRATIONS` are present.

The folded baseline was rehearsed on an empty database in PR #912. Production
recorded only the history marker in a guarded transaction; its schema SQL was
not executed. PR #913 then locked the repaired ledger at strict 267/267 parity.
The 266-row pre-repair backup remains available for rollback.

**Related.** Commits `7de1124` (rename that exposed the drift), `06e9463` (CI env vars), `a381d92` (Edit perms scope). Discovery from `npx supabase migration list` output captured in chat on 2026-05-04.

---

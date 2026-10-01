# Waitlist function rollback rehearsal (B57)

Date: 2026-10-01. **TESTED LOCALLY**, not hosted, deployed or pilot-proven.
Day 22: **NOT_CLOSED**. Master Plan: **NOT_PROVEN**.

## Scope and finding

Detached combined candidate HEAD: `e2680aa7a779448940ba597317e908c503089a66`.
This contains unpublished changes; published PR #1441 CI is not evidence for
these changes. No application behavior or migration SQL body changed in B57.

The three local Waitlist migrations replace four shared functions. Turning a
feature flag OFF does not restore them. The initial rehearsal correctly stopped
before cloning: the previous `claim_waitlist_slot(uuid)` snapshot had
`search_path=public`, whereas the patched function uses an empty search path.
Blind restoration would regress the hardened configuration. The folded baseline
also contains historical grants: it must not be reapplied as a rollback.

Added `scripts/security/waitlist-rollback-definition.mjs`: a SQL-preparation-only
helper that requires the exact reviewed source SHA-256, signature, definer
configuration and qualification anchors. It schema-qualifies 13 legacy public
object references and retains an empty search path without altering business
logic. It never connects, executes, grants, deletes or restores data. Unknown or
changed snapshots fail closed; this is not a general-purpose SQL transformer.
The rollback comment in `20261001011654` now points to this fenced procedure.
Only its comment changed; executable migration SQL is unchanged.

## Local results

PostgreSQL 17.6, owned synthetic clone
`nailiq_waitlist_rollback_20261001_b57`, copied solely from the owned B54/B56
synthetic database. No hosted credentials, provider, application server or
Production connection used. Domain writes were not attached during restoration.

| Check | Result |
| --- | --- |
| SQL-preparation regression tests | 5 PASS, 0 FAIL, 0 skipped |
| Broader local transport/stack/restore safety unit suite, including those 5 | 37 PASS, 0 FAIL, 0 skipped; not 42 unique tests |
| Touched-file ESLint, Node syntax, tracked/staged diff checks | PASS |
| Exception during rollback transaction | PASS: no partial function/data change |
| Committed hardened restoration of 4 functions | PASS: exact definitions/metadata, preserved ACL and data |
| Service-role NULL-token legacy claim | PASS: function resolves correctly, returns zero rows; no booking |
| Exception after reapplying migrations | PASS: restoration state retained atomically |
| Ordered reapply of all 3 migrations | PASS: exact patched function fingerprints recovered |
| Duplicate reapply | PASS: anchor mismatch rejects atomically, no partial change |
| Direct anon/authenticated claim and capacity execution | PASS: all 4 calls denied |
| Source/root preservation | PASS: function, data, ACL/RLS/constraint/policy/trigger fingerprints unchanged |

The source contained 8 Waitlist entries, 7 durable claim receipts and synthetic
booking history. All domain-table row counts and content fingerprints remained
unchanged throughout the clone rehearsal. No synthetic booking, receipt, SMS,
notification or auth user was created by this rehearsal. The empty root database
retained zero salons, users, bookings and profiles. The isolated clone is retained
for evidence, with the patched functions restored at the end.

### Retained failed checks

- `waitlist-rollback-b57.json`: initial security-configuration mismatch; exit 1,
  no clone created, no migration applied.
- Initial unit fixture lookup: failed because the folded pg_dump uses `CREATE`
  and `$$`, not the `pg_get_functiondef` spelling. Corrected fixture extraction;
  this was a harness error, not a product fix.
- `waitlist-rollback-b57-corrected.json`: exact-hash guard rejected a trimmed
  snapshot; exit 1, no clone created. The raw JSON definition has one trailing
  newline. Corrected the reviewed hash, not the guard.
- `waitlist-rollback-b57-corrected-v2.json`: exit 0, all 7 rehearsal phases PASS.
  Expected injected exceptions and duplicate-apply rejection remain in evidence;
  they are not counted as unexpected failures or hidden retries.
- Initial closeout preservation check used the older B52 fixture hash and stopped.
  The existing B53 receipt pins the later fixture hash. Corrected the baseline
  reference to B53; the integration file itself was not changed in B57.

## Required rollback boundary before any hosted rollout

1. Obtain approval for the exact environment, migrations and restoration scope.
   Capture all four actual pre-migration function definitions, signatures, owner,
   grants, settings, constraints, policies and relevant data fingerprints from
   that environment; local snapshots do not prove hosted parity.
2. Fence application writes and drain in-flight commands before function rollback.
   A feature flag alone is insufficient for shared booking functions. Preserve
   committed booking/status/receipt history. Do not delete it to make tests green.
3. Review pinned snapshots. Retain current hardened search paths and service-only
   claim/capacity permissions. Never replay historical GRANT statements or use
   DROP/CREATE to replace functions. Unsupported snapshot drift means STOP.
4. Restore the reviewed four definitions in one bounded transaction with lock
   and statement timeouts. Verify signatures, owner, ACL/settings and data before
   reattaching traffic. On any mismatch, abort and retain the write fence.
5. Local rehearsal temporarily restores legacy business logic; it does **not**
   prove that old capacity/locking behavior is safe to reopen. Prefer an approved
   forward correction. Reapply the three migrations in order, verify exact patched
   definitions, and repeat capacity/concurrency acceptance before reopening writes.
6. Keep a separate hosted security-advisor and tenant/role verification receipt.
   This local metadata test is not a Supabase hosted advisors PASS.

Functions: `claim_waitlist_slot(uuid)`, legacy 14-argument `create_public_booking`,
`resolve_booking_sequence_pricing_and_schedule(jsonb,boolean)`, and
`evaluate_individual_waitlist_capacity(uuid,uuid,uuid,date,text)`.
Order: `20261001011654` → `20261001023547` → `20261001031038`.
The independent inbound-SMS migration is **not** rolled back by this procedure.

## Commands and evidence

```sh
node --test scripts/security/waitlist-rollback-definition.unit.mjs
node --check scripts/security/waitlist-rollback-definition.mjs
node --test scripts/security/waitlist-rollback-definition.unit.mjs scripts/security/local-only-fetch.unit.mjs scripts/security/local-supabase-status.unit.mjs scripts/security/rehearse-supabase-cold-restore.unit.mjs
./node_modules/.bin/eslint scripts/security/waitlist-rollback-definition.mjs scripts/security/waitlist-rollback-definition.unit.mjs
node /private/tmp/nailiq-current-main-combined-iBPOnd/rehearse-waitlist-rollback-b57-corrected-v2.mjs
node /private/tmp/nailiq-current-main-combined-iBPOnd/closeout-b57.mjs
git diff --check
```

Do not blindly rerun the rehearsal: the guarded target already exists, and
artifacts are write-once. Use a newly approved owned synthetic clone with reviewed
snapshots if a new run is needed. Artifacts reside in
`/private/tmp/nailiq-current-main-combined-iBPOnd`; they contain only sanitized
metadata, counts and fingerprints, not raw customer data or secrets.
`combined-rollback-evidence-b57.json` records the checked fingerprints, exact
gate commands/output and preservation of prior B54–B56 artifacts. The tested
migration hash precedes the B57 comment-only change; closeout reconstructs the
previous comment and verifies the exact original SHA-256, proving executable
SQL did not drift.

Only QA helper/tests, this document and a migration rollback comment changed.
Earlier B54/B55/B56 hashes and the four imported staged files are checked for
preservation. Full application unit/typecheck/Next build are not fresh B57 gates;
the earlier results remain separately labeled. Still NOT PROVEN: hosted combined
candidate E2E/migrations/advisors, physical iPhone, real provider/scheduler flow
and first-human pilot acceptance. No commit, push, hosted migration, deployment,
provider call, notification or Production change occurred.

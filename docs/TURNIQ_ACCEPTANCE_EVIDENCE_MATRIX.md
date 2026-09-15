# TurnIQ Master Acceptance Evidence Matrix

This matrix covers all 25 minimum scenarios in
`docs/CODEX_TURNIQ_MASTER_REQUEST.md`. It prevents a local test pass from being
reported as Production or salon-pilot proof.

Evidence labels:

- **Automated local** — mapped to deterministic unit, invariant, security, or
  browser tests in this repository.
- **QA required** — database/UI behavior still requires the disposable QA stack.
- **Physical/pilot required** — cannot be proven by repository tests alone.

| # | Acceptance scenario | Current evidence boundary | Remaining proof |
|---:|---|---|---|
| 1 | 12 staff check in; queue follows arrival | Automated local fixtures plus desktop/mobile browser run with 12 staff in exact arrival order; disposable-QA transaction checked in 12 synthetic staff with positions 1–12 and rolled back cleanly | Physical 12-person tablet run |
| 2 | Late staff does not jump from zero credit | Automated local: baseline and fairness invariants | Shadow-day comparison |
| 3 | Appointment/walk-in/requested service consumes only on completion | Automated local: atomic assignment transitions | QA atomic rollback |
| 4 | Requested no-show consumes no turn | Automated local: no-show/turn invariant | QA lifecycle |
| 5 | Skill mismatch skips without penalty | Automated local: single-customer engine | Shadow trace |
| 6 | Unsafe appointment gap skips without losing place | Automated local: gap safety/invariants | Shadow trace |
| 7 | Approved break preserves queue position | Automated local shift/PIN transition tests plus desktop/mobile browser break/return; disposable-QA PIN lifecycle preserved staff 5 at queue position 5 across break/return | Physical shared-device usability |
| 8 | Unapproved departure/refusal moves to end | Automated local: refusal/shift policy boundaries | QA lifecycle |
| 9 | Two technicians each consume own turn/credit | Automated local: multi-technician handoff engine | QA atomic handoff |
| 10 | Four-person party gets feasible fair plan | Automated local: constrained group matching | QA group lifecycle |
| 11 | Customer rejection does not penalize recommended staff | Automated local: refusal safety | QA lifecycle |
| 12 | Override stores actor/reason/before/after/policy | Automated local: atomic commands and receipt boundaries | QA receipt reload |
| 13 | $20 upgrade updates opportunity credit atomically | Automated local: service-update/credit boundaries | QA rollback/retry |
| 14 | Staff-entered request retains source/actor and is not labelled verified | Automated local: provenance/trust explanations | Shadow pattern report |
| 15 | Policy change defaults to next business day | Automated local: policy/date/timezone invariants | QA timezone boundary |
| 16 | Concurrent confirm cannot double-assign staff/resource | Automated local database contract/security tests; QA PIN check-in race passed | QA assignment/resource race |
| 17 | Retried command returns prior result without duplicate event | Automated local idempotency tests; QA exact retry passed with one command/PIN receipt/event; browser ambiguous-response retry preserved command ID | QA assignment retry |
| 18 | Primary offline device survives reload/reconnect; second cannot write | Automated local: outbox/replay/device authority | **Physical outage test required** |
| 19 | Technician cannot see peer exact revenue/tips | Automated local: read-model/UI/security tests | QA role matrix |
| 20 | Replay deterministic and non-mutating | Automated local: shadow replay/invariants | QA historical comparison |
| 21 | Confirm/override creates exactly one durable Fairness Receipt | Automated local: atomic receipt/idempotency tests | QA retry/concurrency |
| 22 | “Why not me?” protects peer financial privacy | Automated local: explanation/read-model UI | Technician comprehension test |
| 23 | Routine turns do not enter Owner Exception Inbox | Automated local: exception/read-model boundaries | Supervised pilot metrics |
| 24 | True conflict enters inbox with recommended action | Automated local: exception/offline conflict tests | QA conflict lifecycle |
| 25 | First-time owner passes 60-second comprehension demo | Automated local: seeded demo boundary and browser flow | **Timed human/pilot test required** |

## 100% boundary

Code-complete is not the same as 100% TurnIQ. The Master Request reaches 100%
only after the full suite passes, migrations and role/race tests pass on
disposable QA, the physical primary-device outage script passes, the timed
60-second owner test passes, rollback is rehearsed, and a controlled
shadow → supervised → live pilot meets the documented zero-loss/zero-duplicate
gates. Existing live salons remain out of scope until separately approved.

## Verification snapshot for this local change

Fresh local rerun: **2026-09-05** on source SHA
`8b0dc4a4e3a675a9f299cf112c3ce5e7c5e6a09d`. Hosted Preview and disposable-QA
items below are retained as historical evidence from their original run; they
are not presented as a current QA environment.

- Current focused TurnIQ unit/invariant/security/component suite: **79 files,
  454 tests PASS**.
- TypeScript: **PASS**.
- Focused ESLint for all touched executable files: **PASS**.
- Next.js production build: **PASS**.
- Migration-history audit: **PASS** with zero duplicate version IDs, zero
  production-only versions, and zero name mismatches.
- Full local TurnIQ browser suite: **46 PASS, 2 physical-offline tests skipped**
  across desktop Chromium and mobile WebKit. It includes a **12-staff ordered
  check-in plus break/return story**, accessibility checks, same-command retry,
  QR lifecycle, customer check-in, rush-hour trust flow and supervised group
  timing. The two skipped cached-shell outage cases remain assigned to the
  mandatory physical-device gate.
- Historical hosted Preview + disposable-QA SHADOW full-story check: **PASS in
  the original verification run; not freshly repeatable on 2026-09-05 because
  the referenced disposable-QA project no longer exists**. One newly
  created synthetic waiting customer (no phone, email, card, payment, or
  notification request) produced exactly one immutable shadow decision and one
  matched comparison through the authenticated Receptionist Center. A second
  identical page observation produced no duplicate. The test added zero TurnIQ
  assignments/events and zero owner, staff-action, or customer-confirmation
  outbox rows. The synthetic booking was retired, the QA copy was restored to
  `supervised`, and the temporary receptionist session count returned to zero.
- Historical Staff PIN migration plus additive FK-index hotfix evidence:
  **applied to the former disposable QA only; not freshly repeatable on
  2026-09-05**. RLS/ACL, role denial, five-attempt lockout, rotation, exact retry, and
  concurrent check-in evidence passed. A separate 12-staff QA transaction
  verified ordered positions 1–12, approved break/return position preservation,
  14 durable PIN receipts and 14 immutable events, then rolled back with zero
  test rows remaining. That historical QA run did not mutate Production.
- Historical ten-fixture TurnIQ SQL lifecycle run: **PASS on the former
  disposable QA inside self-rolling-back transactions; not freshly repeatable
  on 2026-09-05**. Coverage includes atomic group and staggered
  group plans, business-day rollover, consented swaps, customer check-in,
  dispute/exception commands, multi-technician handoff, redo/repair, refusal
  safety, and privacy-safe skip reviews.
- Historical Supabase QA advisors after verification: **zero TurnIQ
  WARNING/ERROR findings in that run; not freshly repeatable on 2026-09-05**.
  Existing TurnIQ advisor entries are INFO-level hardening/performance guidance
  and are not treated as proof of pilot readiness.
- Physical device and salon pilot: **not run**.

# TurnIQ M3H2 — Redo / Repair Policy Boundary

Status: `LOCAL_TESTED_ONLY`

TurnIQ remains behind `turniq_trust_engine_enabled`; the flag remains OFF for
every salon. This milestone does not call a provider, send a notification, or
create a real booking.

## Product truth

A redo is a new assignment linked to a completed original assignment. The
original assignment, Fairness Receipt and business truth are never rewritten.
Before the new assignment is confirmed, a desk user classifies it as:

- salon/technician quality issue;
- customer damage or change of mind;
- warranty or manager goodwill;
- other, with a required note.

Each immutable policy version maps each configured category independently to:

- consume a turn or not;
- credit the assignment's opportunity amount or not.

There is no universal fallback. If the active policy version lacks the chosen
category, TurnIQ preserves the recommendation, records an owner exception and
requires a new explicit policy version.

## Atomic contract

`apply_turniq_redo_classification_v1`:

- is desk-only and accepts facts, IDs, note and idempotency envelope only;
- locks target/original assignments in stable order;
- requires a new recommended assignment plus a completed same-salon original;
- derives both policy booleans from `turniq_policy_redo_rules`;
- persists classification, command receipt and immutable event atomically;
- creates an audited `redo_policy_missing` exception without changing the
  assignment when policy is incomplete.

`complete_turniq_assignment_command_v2`:

- completes booking, assignment and shift in one transaction;
- applies turn count and opportunity credit independently;
- preserves actual service revenue as separate business truth;
- returns the prior receipt on an exact retry;
- blocks the legacy completion path for any classified redo.

Both RPCs are `SECURITY INVOKER`, service-role-only, and all new policy rows are
RLS-enabled, RLS-forced and immutable. Technician view shows only that person's
redo category, note and policy outcome; it exposes no peer financial amounts.

## Local evidence

- Migration syntax applied to disposable local full-schema PostgreSQL: PASS.
- Synthetic SQL: category mapping, missing-rule exception, no-turn/no-credit,
  turn+credit, separate business revenue, legacy-path rejection, exact retry and
  ACL: PASS.
- Focused TurnIQ TypeScript/UI/security suite: PASS, 19 files and 124 tests.
- Full unit suite: PASS, 653 files passed and 1 skipped; 4,009 tests passed,
  1 skipped and 7 todo.
- TypeScript strict check: PASS.
- Full repository lint: PASS with 42 pre-existing warnings and zero errors;
  touched-file lint has zero warnings.
- Next.js production build: PASS.

## Not included yet

- Owner UI to author a new policy version and all four redo category rules.
- In-progress or multi-technician handoff allocation.
- Group matching, ETA, offline writes, QA, Preview, Production or pilot proof.

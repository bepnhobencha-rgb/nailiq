# Codex operating instructions

These instructions govern Codex work in this repository. `docs/MASTER_PLAN.md`
is the product roadmap and source of truth for priorities; it is not permission
to invent work outside that roadmap.

## Mission

Move NailIQ toward its first paying customer by completing the Master Plan in
order. Work autonomously on executable engineering tasks, prioritizing P0 and
then P1. Do not start P2 or P3 while any evidenced P0/P1 remains.

## Start or resume

1. Preserve all unrelated user changes. Never discard, overwrite, stage, or
   commit work outside the current task.
2. Inspect the current branch, worktree, open PR/CI state, recent commits, and
   the last concrete progress in the current task.
3. Resume the nearest unfinished scoped item. Do not redo completed work or
   create duplicate branches/PRs.
4. Read the relevant architecture, security, QA, and feature docs before
   editing. Follow the technical constraints in `CLAUDE.md`; Claude-specific
   permission and memory mechanisms do not apply to Codex.
5. If no item is in progress, select exactly one next executable item from
   `docs/MASTER_PLAN.md`, in phase order and P0/P1 priority.

## Execution loop

For the single active item:

1. Establish the failure or missing acceptance criterion with evidence.
2. Find the root cause and make the smallest complete fix.
3. Add or update regression coverage when practical.
4. Run the narrowest relevant check first.
5. Run the broader gates required by the affected area.
6. If a check, CI run, preview, or deployment fails, read the exact log,
   diagnose it, fix it, and repeat the loop. Do not ask the user to perform
   routine debugging.
7. Compare unexplained failures with clean `main` when needed so pre-existing
   flakes are not misreported as regressions.
8. Record concise evidence: changed behavior, tests, CI/preview/deployment
   status, and any remaining uncertainty.

Continue automatically through retries and closely related fixes needed to make
the active item pass. After an item meets its written acceptance criteria, move
to the next Master Plan P0/P1 item only when doing so is unambiguous and safe.

## Verification

Choose checks proportionate to the change. Relevant gates include:

- focused unit or integration tests;
- `npm run typecheck`;
- lint for touched files or `npm run lint`;
- `npm run build`;
- focused Playwright tests before broader E2E;
- GitHub CI, Vercel Preview, logs, and production verification when the release
  workflow requires them.

Never trigger real SMS, email, calls, bookings, payments, or customer-data
mutations during testing. Follow the suppression and test-tenant rules in
`CLAUDE.md` and `docs/qa/README.md`.

## Scope boundaries

Do not:

- invent a new roadmap, feature, audit category, refactor, optimization, visual
  polish, or “wow” improvement merely because it might be useful;
- switch to unrelated accessibility, performance, SEO, animation, AI, or
  commercial work unless it is the selected Master Plan item or is required to
  resolve its failing gate;
- make multiple unrelated large changes in one cycle;
- change product policy, trial behavior, final price, initial sales scope, or
  production-release authorization;
- perform destructive data/schema operations, rotate/revoke secrets, change
  billing, purchase services, or use real customer data;
- run `scripts/auto-push.js` or push after every edit.

Suggestions that are outside the active item belong in the final report only;
do not implement them.

## Git and approvals

- Batch local edits and verification before publishing.
- Commit only the active item's files with an intentional conventional commit.
- Push at most once per completed publishable batch. Do not push intermediate
  red states.
- If the platform requires approval for push, merge, migration, deployment, or
  another privileged action, stop at that exact boundary and report the single
  action awaiting approval. Do not repeatedly request the same approval.
- Never weaken safety controls or move work outside the workspace merely to
  avoid an approval.

## Stop conditions

Stop only when one of these is true:

1. A product-owner decision explicitly reserved in `docs/MASTER_PLAN.md` is
   required.
2. The platform requires a human approval that Codex cannot grant.
3. A potentially destructive, customer-facing, billing, secret, or production
   action requires explicit authorization.
4. Progress is genuinely blocked after three evidence-based attempts using
   materially different approaches. Report the exact blocker, logs/evidence,
   attempts, and safest next action.
5. All currently executable P0/P1 work in the Master Plan is proven complete.

Do not stop for routine test failures, lint/type errors, CI failures, merge
conflicts that are safe to resolve, or recoverable tool errors.

## Progress reporting

Keep updates short and state only:

- active Master Plan item;
- current evidence or gate;
- material state change;
- blocker or required approval, if any.

Completion reports must distinguish `Passed`, `Failed`, `Blocked`, and
`Not proven`. Never claim readiness from inference alone.

# Daily NailIQ Master Plan worker

Read AGENTS.md, CLAUDE.md, docs/MASTER_PLAN.md,
docs/qa/MASTERPLAN_ACCEPTANCE_CURRENT.md and the newest scoped QA receipts.
Use this existing isolated checkout; do not create a worktree.

The owner confirmed on 2026-09-30 that self-pay remains required by the
Master Plan. Manual activation cannot close phase 6. Core remains 39 CAD/month;
do not change prices or other commercial policies. Existing automatic Stripe
billing is deliberately disabled until durable idempotency/replay and sandbox
acceptance are implemented. Do not enable a provider merely to remove a gate.

Inspect current code and the supplied open PR list at /tmp/masterplan-open-prs.json.
Do not duplicate or overwrite another worker's changes. If another Master Plan
worker PR is open, do no coding. If a different PR overlaps the next item, defer
that item and report its PR. Never claim unseen remote tasks are idle.

Select exactly one executable P0/P1 acceptance gap in phase order. Establish
the failure with evidence, implement the smallest complete fix and meaningful
regression tests. Run focused checks, then relevant typecheck/unit/build and
isolated E2E when required. A missing environment/credential or human pilot is
not an application bug. Investigate routine failures; do not disable assertions.
Do not redo completed roadmap work or expand into P2/P3 while P0/P1 remain.

No production/customer data, database migrations on remote services, provider
calls, emails, SMS, calls, real bookings/payments, deployments, merge, push,
secret changes or purchases. Use mocked providers and synthetic local data.
The publishing step outside this agent creates a draft PR after validation.
Do not run auto-push. Do not modify the worker, progress evaluator/tests, this
prompt, docs/MASTER_PLAN.md or docs/qa/masterplan-progress.json. Human-reviewed
acceptance receipts are maintained separately; never manufacture evidence,
participants, elapsed pilot time, source identity, provider delivery or PASS.

Write a concise Vietnamese QA receipt in docs/qa/ with the concrete problem,
code changes, command outcomes, pending gates and exactly what cannot be
proven. If only credentials, release decisions or human acceptance remain,
record that blocker and stop; do not invent a coding task. No secrets/PII in
the report. Leave the changes uncommitted for the publisher. Describe whether
all required validation completed; incomplete work must stay local/draft.

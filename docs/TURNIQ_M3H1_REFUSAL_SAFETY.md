# TurnIQ M3H1 — Refusal Safety Boundary

Status: `LOCAL_TESTED_ONLY`

TurnIQ remains behind `turniq_trust_engine_enabled` and the flag remains OFF for
every salon. This milestone does not create or modify a booking, call a provider,
or send a notification.

## Why refusal is a separate milestone

The word "refusal" hides three different operational truths. Treating them as
one generic action would either punish a technician unfairly or let a technician
self-select a no-penalty outcome. M3H1 therefore permits exactly three outcomes:

| Category | Queue/shift outcome | Booking outcome |
| --- | --- | --- |
| `customer_declined` | No penalty; queue position and shift stay unchanged | Unchanged |
| `illness_emergency` | Preserve queue position and start an audited temporary hold | Unchanged |
| `unapproved_refusal` | Move the technician to the current salon-day queue end | Unchanged |

Only Owner/Admin/Senior/Receptionist can classify the outcome. The affected
technician sees their own category, outcome and note in Staff View. A technician
may raise a dispute through the existing trust surface, but cannot mark their
own refusal as approved.

## Atomic contract

`apply_turniq_refusal_command_v1`:

- revalidates membership, role, feature flag, active policy and salon-local day;
- accepts only a current `recommended` assignment and its active recommended
  technician shift;
- takes command and salon-day advisory locks before mutable row locks;
- persists the rejected recommendation and refusal truth on the assignment;
- changes the shift only when the selected policy category requires it;
- commits the command receipt and immutable assignment/shift events in the same
  transaction;
- replays the prior result for the same command ID and fingerprint;
- is `SECURITY INVOKER`, executable only by `service_role`, and leaves all
  TurnIQ ledger tables RLS-enabled, RLS-forced and unavailable to browser roles.

The public UI sends only IDs, category, note and the idempotent command envelope.
Salon, actor, policy and current assignment/shift truth are re-read server-side.

## Local evidence

- Four focused TypeScript/UI/security files: PASS, 24 tests.
- Full unit suite: PASS, 652 files passed and 1 skipped; 4,000 tests passed,
  1 skipped and 7 todo.
- Migration applied to the disposable local full-schema TurnIQ database: PASS.
- Synthetic SQL scenarios: unapproved queue-end, emergency hold, customer
  decline, exact retry, desk-only classification and RPC ACL: PASS.
- TypeScript strict check: PASS.
- Full repository lint: PASS with 42 pre-existing warnings and zero errors;
  focused touched-file lint has zero warnings.
- Next.js production build: PASS.
- Local metadata: TurnIQ ledger RLS enabled and forced; browser table grants
  absent; refusal RPC is invoker-only and service-role-only.

## Not included yet

- Redo/repair category-to-policy mapping and completion credit behavior.
- Two-technician consented swap and correction history.
- Recommending/reassigning the customer after a refusal.
- QA, Preview, Production, live-salon enablement or pilot proof.

Those remain separate reviewable milestones so neither redo money/turn policy nor
swap assignment truth is approximated by a superficial placeholder.

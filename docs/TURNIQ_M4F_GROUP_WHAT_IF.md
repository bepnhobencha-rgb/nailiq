# TurnIQ M4F — Receptionist Group What-if

Status: `LOCAL_TESTED_READ_ONLY_UI`

TurnIQ remains default OFF. This milestone did not write a booking, hold a
resource, persist a group plan, create a command receipt, call a provider,
apply QA/Production, commit or push.

## Outcome

Receptionist Center now places a clearly separated **What if?** section under
each eligible group. One tap compares:

- arrive together;
- leave together;
- Smart Wave.

All three simulations use exactly one authoritative server snapshot. The user
may choose a bounded search window and a leave-together offset. The browser
cannot supply staff, resource, policy, fairness score or internal trace.

Each result shows only operational truth: feasibility, maximum wait, wave
count, technician, service window and wave number. The option with the lowest
proven wait is labelled as such; NailIQ does not silently call it the owner's
policy choice.

## Safety behavior

- The simulation area says that no booking changed and has no Apply/Confirm
  control.
- It reuses the same M4C trusted group snapshot loader used by the authoritative
  recommendation path, preventing a second staff/skill/resource truth.
- The server authorizes active salon membership, TurnIQ flag and desk role
  before loading service-role data.
- The client receives no peer money, tips, fairness tier/queue costs, decision
  fingerprint, internal trace or customer PII.
- Offline keeps the last comparison visible but disables a new comparison.
- Stale or mismatched results never replace the group currently being viewed.
- No command ID or receipt is created because this is a read-only comparison.

## Local evidence

- One shared snapshot feeds all three timing simulations: PASS.
- Input schema accepts only salon/group identifiers and bounded time offsets:
  PASS.
- UI clearly shows all three options, lowest-wait label and unsafe/no-plan
  result: PASS.
- No Apply/Confirm button exists in the What-if surface: PASS.
- Offline retains last-known results and disables refresh: PASS.
- Privacy-safe projection excludes internal fairness money/trace and customer
  PII: PASS.
- Focused engine/UI/server/security verification: 7 files and 31 tests PASS.
- Full unit suite: 667 files and 4,077 tests PASS; one file/test remains skipped
  and 7 tests remain todo outside this milestone.
- TypeScript strict check, full ESLint, diff whitespace check and Next.js 16.3.1
  production build: PASS. Existing Edge Runtime warnings are unchanged.

## Not included yet

- Persisting a chosen timing intent.
- Converting a staggered simulation to booking rows or an atomic TurnIQ plan.
- Customer approval, notification, realtime ETA or offline mutation.
- QA, Preview, Production or pilot proof.

Next safe milestone is M4G: define the atomic staggered-plan persistence and
revalidation contract. It must remain feature-gated and must not mutate an
existing booking until the complete group transaction can be proven safe.

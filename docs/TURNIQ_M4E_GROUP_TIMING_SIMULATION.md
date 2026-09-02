# TurnIQ M4E — Group Timing Simulation

Status: `LOCAL_TESTED_PURE_SIMULATION_ONLY`

TurnIQ remains default OFF. This milestone did not change a booking, queue,
ledger, resource, database, QA, Preview or Production environment. It did not
call a payment or messaging provider, commit or push.

## Outcome

TurnIQ now has one deterministic, replayable contract for three distinct group
timing intents:

- `start_together`: all guests receive the same proven-safe start. NailIQ may
  move the entire party later inside the permitted window, but never silently
  split it.
- `finish_together`: each guest may start at a different time according to
  service duration, while every service releases at the same requested finish.
- `smart_wave`: staff and resources may be reused only after their prior block
  is released; the engine minimizes the maximum and total wait inside the
  settled TurnIQ objective order.

The result always contains `liveStateChanged: false` and the explicit reason
`TIMING_SIMULATION_ONLY`. It cannot be confused with a confirmed booking plan.

## Safety and trust boundary

- Reuses M4A's policy validation, staff eligibility, skill, resource and
  duration rules instead of creating a second eligibility truth.
- Preserves requested-technician precedence, appointment-gap safety, fairness
  tier, queue order and stable deterministic tie-breaks.
- Planned catalog/add-on opportunity credit follows a technician into later
  waves, so the simulator does not repeatedly favor the same technician as if
  earlier planned guests did not exist. It never treats tax or tip as fairness
  credit.
- A staff member or chair/bed/room can be reused across smart waves only when
  half-open service intervals do not overlap.
- The timing window is limited to the same salon-local business day and at most
  12 hours.
- Search is bounded. If NailIQ cannot prove the complete best plan within the
  bound, it returns no plan and requests desk review.
- A proven homogeneous fast path covers the common oversized-party case (for
  example 12 identical Classic services with 7 technicians) when there are no
  requested technicians or upcoming-appointment deadlines. Mixed services and
  appointment-constrained groups stay on the bounded general solver.
- Semantic input permutations produce the same fingerprint and assignments.
- Customer-safe wording exposes neither peer money nor the internal score.

## Local evidence

- Start-together moves a three-person party to one common safe time: PASS.
- Finish-together offsets 60- and 30-minute services to one release time: PASS.
- Smart-wave safely serves three 70-minute guests with two technicians and
  reuses capacity only after release: PASS.
- Twelve identical 70-minute guests with seven technicians resolve to 7 guests
  now and 5 after the exact 70-minute release, without a 15-minute rounding
  delay: PASS.
- One technician and one chair can serve the next guest only after both are
  released: PASS.
- A technician used in an earlier wave carries projected opportunity credit;
  the next equally safe wave prefers an unused eligible technician: PASS.
- Trusted requested technician stays ahead of a shorter unrequested wait: PASS.
- Unsafe appointment gaps return no complete plan: PASS.
- Task/staff input permutation remains deterministic: PASS.
- Static boundary proves no database/provider/browser mutation and explicit
  fail-closed simulation truth: PASS.
- Focused M4A/M4E/security verification: 4 files, 28 tests PASS.
- Full unit suite: 665 files and 4,070 tests PASS; one file/test remains
  skipped and 7 tests remain todo outside this milestone.
- TypeScript strict check, full ESLint, diff whitespace check and Next.js 16.3.1
  production build: PASS. Existing Edge Runtime warnings are unchanged.

## Not included yet

- Persisting a selected timing preference.
- Converting a simulation into staggered booking rows or a TurnIQ group ledger
  plan.
- Receptionist “What if?” UI, customer confirmation, realtime ETA or offline.
- QA, Preview, Production or pilot evidence.

M4F now adds a clearly labelled Receptionist “What if?” comparison surface
that reads one shared trusted snapshot and never confirms or mutates a
staggered plan. See `docs/TURNIQ_M4F_GROUP_WHAT_IF.md`.

# Master Request for Codex — Build TurnIQ Trust Engine

> Copy the section beginning with **START OF CODEX REQUEST** into a new Codex
> task. This is an implementation request, not proof that TurnIQ already exists
> or is production-ready.

---

## START OF CODEX REQUEST

You are working in the NailIQ repository. Build **TurnIQ Trust Engine**, a
per-salon, explainable system that recommends the next eligible nail technician
for appointments and walk-ins while balancing revenue opportunity, respecting
queue order, skills, schedules, customer requests, and salon-specific rules.

The product owner has been a nail technician, salon owner, and software builder.
The decisions in the two TurnIQ documents below are authoritative product input;
do not reopen settled product questions unless the code or data model reveals a
material safety blocker.

### 1. Read before changing code

Read these files completely:

1. `AGENTS.md` and any nested applicable `AGENTS.md` files.
2. `PROJECT_BRAIN.md`.
3. `docs/BASE_RELEASE_CHECKLIST.md`.
4. `src/shared/features/featureRegistry.ts`.
5. `docs/TURNIQ_V1_PRD.md`.
6. `docs/TURNIQ_WOW_RESEARCH.md`.

Then inspect the existing Receptionist Center, walk-in queue, staff schedules
and capabilities, bookings, resources, group scheduler, audit/event code,
service worker, tenant/RLS model, migrations, and test conventions.

Before edits, report:

- current branch, SHA, and dirty-worktree files;
- current functionality that can be reused;
- schema and contract conflicts or gaps;
- existing local tests and the exact verification commands;
- a phased implementation plan with rollback boundaries.

Preserve all unrelated user changes. Do not overwrite or remove the two TurnIQ
documents. Do not assume migration files equal the production schema.

### 2. Product outcome

TurnIQ must allow a walk-in-heavy nail salon to operate normal turns without the
owner standing at the front desk and must reduce customer wait without harming
booked appointments.

Initial salon profile:

- one salon;
- approximately 12 technicians;
- approximately 40 appointments and 10 walk-ins on a busy day;
- technicians may share front-desk work;
- technicians currently calculate their own service totals;
- one owner-designated device must eventually support the core workflow offline.

The system must not promise equal earnings or perfect fairness. Product language
must state that NailIQ applies the salon's agreed opportunity rules consistently
and records exceptions.

### 3. Authoritative Salon A turn policy

Implement the policy as a versioned per-salon configuration, not universal
hardcoded behavior.

#### Start of day

- Reset the active turn queue at the salon-local business-day boundary.
- Technicians enter in check-in order.
- A late technician joins the end.
- A late technician must not jump ahead simply because today's earned revenue is
  zero.

#### What consumes one turn

- A completed appointment consumes one turn.
- A completed walk-in consumes one turn.
- A completed customer-requested service also consumes one turn.
- When two technicians serve the same customer, each consumes one turn and
  receives only the service credit attributable to their work.
- A requested customer who no-shows consumes no turn.
- A customer rejecting the recommendation does not penalize the recommended
  technician or change that technician's queue position.

#### Eligibility before ranking

A technician is eligible only when all are true:

1. checked in and active;
2. not currently busy;
3. not on an approved break or temporary hold;
4. qualified for the requested service;
5. has sufficient time to finish before the next appointment;
6. has no active refusal penalty or manual safety hold.

A skill mismatch or insufficient appointment gap skips the technician without
moving them to the end. They retain their place for the next suitable customer.

#### Requested technician provenance

An explicit customer request takes precedence when feasible. Persist the source:

- `customer_selected` — selected directly in public booking;
- `ai_confirmed` — explicitly confirmed in a connected AI phone flow;
- `staff_entered` — owner/receptionist entered the caller's claimed request;
- `in_person` — customer requested at check-in;
- `imported` — provided by an imported system;
- `override` — manager changed the recommendation.

Always retain actor and timestamp. Never present `staff_entered` as independently
verified customer intent. Report unusual request patterns for review, but never
automatically accuse a person of fraud.

#### Ranking

After eligibility filtering, rank lexicographically:

1. lower opportunity credit when candidates are outside the salon fairness band;
2. active queue position/check-in order when inside the fairness band;
3. stable staff ID as the final deterministic tie-breaker.

Salon A starts with a configurable CAD $20 fairness band. This is a pilot
hypothesis, not a permanent universal default.

Use separate truths:

- business truth: actual service revenue, payment, tip, and future commission;
- fairness truth: opportunity credit used only for turn recommendations.

Salon A's opportunity credit uses catalog/list price plus permitted add-ons,
before tax and tip. Tips and tax never affect ranking. Preserve actual revenue
separately. A permitted price or service upgrade must update opportunity credit.

At check-in, record a non-cash fairness baseline so a late arrival does not gain
priority from a zero balance. Implement the formula as a policy strategy and
cover it with simulation fixtures before enabling live assignments. Initial
candidate formula:

`fairness credit = service credit since check-in + median eligible-team credit at check-in`

#### Exceptions

- Approved break freezes queue position and restores it on return.
- Unapproved departure moves the technician to the end.
- Refusing an eligible customer without an approved reason moves the technician
  to the end.
- Illness/emergency may create a no-penalty hold with an audited reason.
- Swaps require confirmation; turns and credit follow the people who actually
  perform the work.
- Every override requires a reason visible to affected technicians.
- Redo/repair must be categorized, and the salon policy decides whether it
  consumes a turn and/or revenue credit.
- Policy changes take effect next salon-local business day by default. Emergency
  same-day changes require a reason and an immutable event.

### 4. Decision engine requirements

Do not use a black-box AI score or machine learning to decide fairness in V1.
Build a pure deterministic engine with explicit typed inputs and outputs.

Every decision must return:

- recommended technician;
- policy version;
- decision timestamp and fingerprint;
- eligible candidates;
- machine-readable reason codes;
- why earlier-looking candidates were skipped;
- a one-line privacy-safe human explanation;
- a complete internal decision trace available only to authorized roles.

Example explanation:

> Recommend Mai: available now, qualified for Deluxe Pedicure, safe before the
> next appointment, and earlier under the active fairness policy.

Technicians must not see exact peer revenue, peer tips, or the full internal
score. Owners/managers may see the complete report.

For single customers, use deterministic constraint filtering and lexicographic
ranking. For simultaneous groups, use constrained matching so a greedy first
choice cannot make the remaining group impossible. Objective order is:
feasibility, requested-tech constraint, appointment safety, customer wait,
fairness cost, then stable tie-break.

### 5. Data integrity and security

Use a dedicated authoritative TurnIQ ledger. The current best-effort audit log
is not sufficient for fairness state.

An assignment/status transition must atomically commit:

- domain status change;
- assigned technician;
- turn consumption/state;
- opportunity credit;
- resource occupancy where enabled;
- immutable decision or override event;
- idempotent command receipt when a command ID is supplied.

Required conceptual entities are described in `docs/TURNIQ_V1_PRD.md`, including:

- versioned turn policies;
- staff shift/check-in sessions;
- turn assignments;
- append-only turn events;
- offline command receipts.

Use existing schema naming and contracts where safe; do not blindly create
duplicate concepts. All reads and writes must be salon-scoped and role-checked.
Additive migrations must include indexes, constraints, RLS/policies, and rollback
notes. Never weaken an existing tenant or permission safeguard.

Prevent silent technician self-assignment. If the user who added the customer
assigns themselves against the recommendation, require an audited override
reason and apply the salon's configured confirmation rule.

### 6. Required product surfaces

Integrate with existing NailIQ surfaces instead of rebuilding them:

1. **Staff check-in:** PIN, check-in order, break/return, connectivity state.
2. **Receptionist Center / Turn Board:** appointments, walk-ins, active service,
   recommendation, reason, skipped reasons, resource, confirm, override, hold,
   start, and complete.
3. **Staff View:** own status, queue position, turn count, assignment, privacy-safe
   explanation, start/complete/add service, and dispute flag.
4. **Customer check-in/ETA:** QR or kiosk, service and party size, requested
   technician provenance, conservative wait-time range, no internal earnings.
5. **Owner policy/report:** versioned rules, effective date, fairness band,
   revenue basis, redo/refusal policies, exact owner-authorized financial view,
   overrides, swaps, penalties, disputes, request-source patterns, and offline
   reconciliation.
6. **TurnIQ Replay:** read-only deterministic comparison of a historical day
   under current versus proposed policy; never mutate historical/live records.

The core no-receptionist flow must take very few taps. Normal assignments should
not require the owner. Exceptions must remain visible and reviewable.

### 7. Offline boundary

Offline support is required for TurnIQ V1, but implement it only after the online
atomic engine and shadow mode pass.

V1 permits exactly one owner-designated **Primary Offline Device** per salon to
mutate queue state while disconnected. Other disconnected devices are cached
read-only. Do not attempt unrestricted multi-device offline writes or CRDT merge
for assignment state.

The primary device must eventually support offline:

- check-in/out and break/return;
- add walk-in;
- recommend and confirm from a cached, versioned salon snapshot;
- start and complete;
- permitted service/add-on updates;
- override with reason.

Every offline command must be persisted to IndexedDB before displaying success
and contain a device-generated UUID, salon, device, local sequence, policy
version, actor, timestamp, and request fingerprint. Replay must be idempotent and
ordered. Conflicts create an explicit reconciliation task; they never silently
overwrite either side. Keep an always-visible offline/unsynced count.

While offline, never claim SMS, email, push, AI voice, payment-provider, or
cloud-only actions succeeded.

Produce a threat/concurrency model and destructive outage test plan before
enabling offline writes.

### 8. Signature 10/10 experience — not optional polish

TurnIQ is not accepted merely because the assignment algorithm is correct. It
must create an immediate, demonstrable operating change that a salon owner and
technician understand without reading documentation.

#### A. One-screen TurnIQ Live Board

The primary Receptionist Center view must answer these questions at a glance:

1. Who should take the next customer?
2. Why were they selected?
3. Who was skipped, and for what operational reason?
4. Which customers are waiting, booked, assigned, or in service?
5. What is each customer's conservative wait range?
6. Does the owner need to act, or can the team continue normally?

Make the next recommendation the dominant visual element. Keep normal actions to
one tap. Use clear status language rather than exposing formulas or dense tables.
The UI must remain understandable on the salon tablet during a busy period.

#### B. Fairness Receipt for every turn

Every confirmed or overridden assignment must create a durable **Fairness
Receipt** containing:

- recommended and assigned technician;
- privacy-safe selection reason;
- customer-request provenance and trust label;
- skipped-reason codes;
- policy name/version and fairness-band rule;
- actor, timestamp, resource, service, and command/decision fingerprint;
- override, correction, dispute, and resolution history without rewriting the
  original record.

Technicians see their own actionable receipt without peer financial amounts.
Owners/managers may inspect the complete authorized record. The receipt is the
shared answer to “why did this happen?” and must survive reload, retry, and
offline reconciliation.

#### C. Owner Freedom Mode

Normal turns must proceed without an owner decision. Any authorized team member
may add a customer and confirm the system recommendation. The owner receives an
**Exception Inbox**, not a stream of routine approvals.

Exceptions include:

- unsafe or impossible assignment;
- self-assignment override requiring confirmation;
- unresolved staff dispute;
- suspiciously unusual requested-tech pattern for review;
- stale policy/snapshot;
- offline sync conflict;
- duplicate/concurrent command attempt;
- appointment or resource risk that cannot be resolved safely.

When the Exception Inbox is empty, the Live Board must explicitly say that the
salon can continue without owner action. Do not generate noisy alerts for normal
operations.

#### D. One-tap “Why not me?” and “What if?”

An affected technician can request a privacy-safe explanation such as skill
mismatch, approved break, insufficient appointment gap, requested technician,
active hold, or position inside the fairness band. Never expose another
technician's exact money.

An owner can simulate an alternative assignment or policy without changing live
state. Show the operational consequences: appointment risk, estimated customer
wait, resource conflict, queue/fairness effect, and whether an override would be
recorded. Simulation must be deterministic and visually distinguished from live
state.

#### E. End-of-shift trust summary

Provide two views:

- owner: total customers, waits, recommendation acceptance, overrides, request
  sources, disputes, exceptions, and opportunity distribution;
- technician: own customers, turn count, own service credit, skips and reasons,
  approved breaks, and unresolved disputes.

Do not rank or shame technicians. The summary must help the team settle the day
from a shared record instead of memory or argument.

#### F. Mandatory 60-second comprehension and rush-hour demo

Create a seeded, production-like Salon A demo with 12 technicians, appointments,
walk-ins, requested clients, mixed skills, breaks, a group, an upgrade, one
override, and an upcoming appointment conflict.

Within 60 seconds, a first-time owner must be able to identify:

- the next recommended technician;
- the reason;
- the expected customer wait range;
- whether owner intervention is required.

The scripted demo must then prove, without hidden manual data edits:

1. add a walk-in and receive an explainable recommendation;
2. skip an ineligible technician without taking their place;
3. identify a staff-entered requested-tech claim;
4. complete service and update the next recommendation atomically;
5. show the resulting Fairness Receipt;
6. replay the scenario under another fairness band without live mutation;
7. lose Internet on the designated device, continue core operations, reload,
   reconnect, and sync with no lost or duplicate command when M5 is complete.

The 10/10 experience gate is **FAIL** if the demo requires the owner to calculate
turn order, inspect exact staff earnings, navigate multiple administrative pages,
or verbally explain why the recommendation is fair.

### 9. Scope controls

Keep TurnIQ behind a new per-salon feature flag, default **OFF**. Do not enable it
for existing salons or production during this task.

Included:

- deterministic Money-Balanced Rotation;
- policy versions and atomic ledger;
- requested-tech provenance;
- explainable recommendation and human confirmation;
- audited overrides, swaps, penalties, redo, and disputes;
- shadow/replay mode;
- existing staff/service/schedule/resource integration;
- primary-device offline architecture and implementation in its later phase;
- instrumentation required for a pilot.

Explicitly excluded:

- replacing the POS or payment terminal;
- payroll, tax filing, or commission payout;
- AI voice receptionist;
- loyalty, gift cards, or broad marketing;
- native mobile apps;
- black-box AI assignment;
- unrestricted multi-device offline writes;
- exposing exact peer earnings;
- automatic accusations of favouritism;
- enabling production or changing live-salon policy.

### 10. Mandatory implementation sequence

Work in small reviewable milestones. At each milestone, update the plan, run
targeted tests, run the existing relevant suite, inspect the diff, and report
what is code-complete versus not deployed or pilot-proven.

#### M0 — Audit and contracts

- Map reuse points and current contracts.
- Define typed decision input/output and reason codes.
- Define schema/RPC/event/idempotency/offline boundaries.
- Create representative Salon A fixtures.
- Do not change live behavior.

#### M1 — Trust foundation

- Add feature flag default OFF.
- Implement additive policy/ledger schema with tenant security.
- Implement pure deterministic single-customer engine.
- Implement requested-tech provenance and privacy-safe explanations.
- Add comprehensive unit/property/invariant tests.

#### M2 — Replay before control

- Read current Receptionist Center state in shadow mode.
- Store/compare recommendation versus actual human assignment.
- Build deterministic historical replay and policy comparison.
- Add baseline metrics without mutating turn order.

#### M3 — Supervised online flow

- PIN check-in and staff shift state.
- Recommendation/confirm/override/start/complete as atomic operations.
- Integrate existing booking, walk-in, capabilities, schedule, and resources.
- Add the one-screen Live Board, Fairness Receipt, Owner Freedom Mode, Exception
  Inbox, Staff View, and dispute resolution.

#### M4 — Group and customer flow

- Constrained group matching and multi-technician credit.
- QR/kiosk check-in.
- Conservative customer ETA range and accuracy instrumentation.

#### M5 — Offline continuity

- Cached application shell and versioned salon snapshot.
- Primary-device authority.
- IndexedDB outbox and idempotent server receipts.
- Reconciliation UI.
- Reload, reconnect, duplicate replay, divergence, and storage-failure tests.

#### M6 — Pilot hardening

- Observability, export/recovery, rollback rehearsal, accessibility, responsive
  checks, performance, and representative end-to-end tests.
- Produce a pilot runbook. Do not activate a live salon.
- Produce and verify the seeded 60-second comprehension/rush-hour demo.

If the entire sequence is too large for one task, complete M0 and M1 to a clean,
tested boundary first, then provide exact next-task prompts for M2–M6. Do not
create superficial placeholders across every phase merely to claim completion.

### 11. Minimum acceptance scenarios

Automate these scenarios at the appropriate layer:

1. Twelve technicians check in; queue order matches arrival.
2. A late technician with zero service credit does not jump ahead.
3. Appointment, walk-in, and requested customer each consume a turn only after
   the configured completion event.
4. Requested no-show consumes no turn and preserves position.
5. Skill mismatch skips without penalty.
6. Insufficient time before a booking skips without losing position.
7. Approved break preserves position.
8. Unapproved departure or unjustified refusal moves to the end.
9. Two technicians on one customer each receive one turn and their own credit.
10. A four-person party receives a feasible fair assignment plan.
11. Customer rejection does not penalize the recommended technician.
12. Override records actor, reason, before/after state, and policy version.
13. A $20 upgrade updates opportunity credit atomically.
14. Staff-entered requested-tech claims retain source/actor and appear in owner
    analysis without being called verified customer intent.
15. Policy change today takes effect next salon-local business day.
16. Concurrent confirmation cannot double-assign a technician or resource.
17. Retried command ID returns the prior committed result without duplicating a
    turn or event.
18. Offline primary device survives reload and reconnect without loss or
    duplicates; a second offline device cannot write as primary.
19. Technician views never reveal peer exact revenue or tips.
20. Replay is deterministic and never mutates live or historical records.
21. Every confirmation/override produces exactly one durable Fairness Receipt.
22. A technician can answer “Why not me?” without seeing peer financial data.
23. Routine operations do not enter the owner's Exception Inbox.
24. A true conflict enters the Exception Inbox with a clear recommended action.
25. A first-time owner passes the 60-second comprehension test on the seeded
    Salon A scenario.

Add tests for timezone/daylight-saving boundaries, tenant isolation, role
permissions, stale policy versions, stale snapshots, partial failures, and
reconciliation conflicts.

### 12. Pilot evidence and success gates

Instrument these measures, but label targets as hypotheses until a real nail
salon baseline exists:

- owner minutes spent deciding normal turns;
- customer-add to confirmed-assignment time;
- customer wait distribution and walk-away rate;
- recommendation acceptance rate;
- documented override rate and reasons;
- opportunity-credit spread among comparable eligible hours;
- staff disputes/trust feedback;
- lost or duplicate offline commands.
- percentage of normal turns completed without owner intervention;
- median time for a new user to understand and confirm a recommendation;
- percentage of assignment disputes resolved from the Fairness Receipt without
  reconstructing events verbally.

Pilot sequence: baseline, shadow, supervised, then live pilot with a documented
recovery procedure. Proposed go-live gates include zero duplicate assignments,
zero lost offline commands, full override/request provenance, and a successful
rollback rehearsal. Never equate passing local tests with production or pilot
proof.

### 13. Delivery and safety rules

- Do not deploy, enable a live salon, run production migrations, mutate
  production data, commit, push, or open/merge a PR without explicit approval.
- Do not make external provider calls or send customer/staff notifications
  during development verification.
- Use synthetic fixtures or an explicitly approved non-production tenant.
- Never weaken booking, tenant, role, payment, or security safeguards.
- Preserve dirty-worktree changes.
- Report exact test commands and results, remaining risks, migrations created,
  rollback steps, and manual QA still required.
- Label every claim as one of: existing before this task, implemented locally,
  tested locally, deployed, production-verified, or pilot-proven.

Begin with M0. Continue into M1 only after the audit shows a safe additive path.

## END OF CODEX REQUEST

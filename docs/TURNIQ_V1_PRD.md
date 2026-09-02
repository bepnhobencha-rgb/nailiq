# TurnIQ V1 — Product Requirements Document

> Status: Draft for product-owner review
> Evidence source: Direct operating experience from Huy as a nail technician,
> salon owner, and software builder
> Scope: Product and technical requirements only. This document is not evidence
> that TurnIQ is implemented, deployed, or production-proven.

## 1. Product decision

TurnIQ is a per-salon policy engine for assigning appointments and walk-ins to
eligible technicians fairly, quickly, and transparently.

TurnIQ is not a universal round-robin rule. Each salon owns a versioned policy.
The first validated profile is **Money-Balanced Rotation**, derived from a salon
workflow with approximately:

- 12 technicians;
- 40 appointments on a busy day;
- 10 walk-ins on a busy day;
- technicians sharing front-desk work when no receptionist is present.

The two primary 30-day outcomes are:

1. The owner no longer needs to stand at the front desk to assign turns.
2. Customers wait less before service starts.

## 2. Product principles

1. **Salon-configurable:** rules are stored per salon and never hardcoded as a
   universal policy.
2. **Explainable:** every recommendation states why a technician was selected.
3. **Auditable:** every assignment, override, penalty, policy change, and price
   change records actor, timestamp, reason, and before/after state.
4. **Flexible without becoming arbitrary:** legitimate exceptions are fast;
   hidden favouritism is visible.
5. **Offline-operable:** the designated salon device must continue the core
   turn workflow during an Internet outage.
6. **Human-controlled:** V1 recommends a technician; a permitted human confirms
   the assignment.
7. **No false readiness:** code, local tests, deployment, production verification,
   and pilot proof are separate evidence states.

## 3. User roles

### Owner / Manager

- Configure and schedule policy changes.
- See revenue, tips, assignment history, overrides, and anomaly reports.
- Correct a completed action with a required reason.
- Designate the primary offline device.

### Receptionist

- Add appointments and walk-ins.
- Accept a TurnIQ recommendation.
- Override a recommendation with a required reason.
- Change the assigned chair, bed, or room.
- Update service/add-on price where permitted.

### Technician

- Check in with a PIN.
- Add a walk-in when no receptionist is present.
- See their queue position, assignment, turn count, and explanation.
- Accept or acknowledge an assignment.
- Start and complete service.
- Add a permitted service or add-on.
- Flag a disputed assignment for manager review.

Technicians do not see other technicians' exact revenue or tip amounts in V1.

### Customer

- Check in by QR or kiosk.
- See an estimated wait time.
- Never see private technician earnings or internal turn order.

## 4. Money-Balanced Rotation policy — Salon A

### 4.1 Start of day

- The turn queue resets each salon-local business day.
- Technicians enter the queue in check-in order.
- A technician who arrives late joins the end of the queue.
- A late technician must not jump ahead merely because their daily revenue is
  zero.

### 4.2 What consumes a turn

- A completed appointment consumes one turn.
- A completed walk-in consumes one turn.
- A completed customer-requested appointment or walk-in consumes one turn.
- When two technicians serve the same customer, each technician consumes one
  turn and receives the service revenue attributed to their own work.
- A requested customer who does not arrive does not consume the technician's
  turn.
- A customer rejecting the recommended technician does not penalize that
  technician or change their queue position.

### 4.3 Eligibility before ranking

A technician is eligible only if all conditions pass:

1. Checked in and active for the salon.
2. Not currently busy.
3. Not on an approved break or temporary hold.
4. Capable of performing the requested service.
5. Has enough time to complete the service before their next appointment.
6. Has not been temporarily excluded by an active penalty or manual safety hold.

Being skipped because of skill or insufficient time does not move the
technician to the end of the queue. They retain their place for the next
suitable customer.

### 4.4 Requested technician

- An explicit customer request takes precedence over normal ranking.
- The request source must be recorded: online customer selection, AI/phone,
  receptionist phone entry, in-person request, or imported booking.
- A phone booking marked as customer-requested records the actor and timestamp.
- The system reports requested-technician rates by creator and technician so a
  pattern of owner-entered favouritism is visible.
- The system cannot prove what a caller verbally said unless a connected phone
  system supplies that evidence; it must not present an owner-entered checkbox
  as independently verified customer intent.

### 4.5 General ranking

After eligibility filtering, TurnIQ ranks candidates using this order:

1. Revenue opportunity balance outside the salon's fairness band.
2. Existing queue position/check-in order when candidates fall inside the
   fairness band.
3. Deterministic staff ID as a final technical tie-breaker only.

The salon configures a fairness band from CAD $0 to $100. Salon A starts with a
proposed CAD $20 default. Example:

- Technician A credited at $100 and B at $115: treat as equal and use queue
  order.
- Technician A credited at $100 and B at $150: prefer A if both are eligible.

The fairness-band default is a pilot hypothesis, not a proven optimum.

### 4.6 Preventing late-arrival advantage

On check-in, a technician receives a non-cash **fairness baseline** representing
the salon's current eligible-team balance. The baseline affects ranking only;
it is never shown as earned revenue and never enters payroll or reporting.

This prevents a noon arrival with $0 from immediately taking the largest jobs
ahead of technicians who arrived on time. The exact baseline formula must be
simulated before pilot. Candidate formula for V1:

`fairness credit = service revenue since check-in + median eligible-team credited revenue at check-in`

### 4.7 Revenue basis

Revenue used for ranking is configurable per salon:

- `list_price`: catalog price plus added services/add-ons, before tax and tip;
- `net_service_price`: actual service price after discounts, before tax and tip;
- future: commission credit, not in V1.

Salon A uses `list_price`. Tips and taxes never affect assignment ranking.
Owner reports show tips separately.

If a customer upgrades from a $40 service to a $70 service, the technician's
credited revenue updates immediately when the permitted user adds the upgrade.

### 4.8 Breaks, absence, and refusal

- Approved break: freeze queue position; restore it when the technician returns.
- Unapproved departure: move to the end of the queue.
- Refusing an eligible customer without an approved reason: move to the end.
- Illness or unavoidable emergency: manager may hold/remove the technician
  without penalty, with a visible reason.

### 4.9 Swap and override

- Two technicians may agree to swap a customer.
- Receptionist or manager confirms the swap.
- Turn consumption and revenue credit follow the technicians who actually
  perform the work.
- Every override requires a reason visible to affected technicians.
- Valid examples include customer dissatisfaction, illness, emergency,
  capability correction, customer request, or schedule protection.

### 4.10 Redo / repair work

Free redo work is classified before TurnIQ changes the queue:

- salon/technician quality issue;
- customer damage/change of mind;
- warranty or manager goodwill;
- other, with required note.

Each salon maps the categories to a policy: consume turn or not, and credit
revenue or not. No universal redo rule is hardcoded.

### 4.11 Group customers

For a group requiring multiple technicians:

1. Filter by skill, availability, and sufficient time.
2. Select the required number of technicians with the lowest credited revenue
   outside the fairness band.
3. Use queue position to break ties inside the band.
4. Respect explicit customer requests.
5. Record one assignment and revenue share per technician.

## 5. Recommendation explanation

Every recommendation returns a machine-readable decision and a human-readable
explanation. Example:

> Recommend Mai: checked in, available now, qualified for Deluxe Pedicure, no
> appointment conflict, and credited revenue is below the active fairness band.

The explanation must also list why earlier-looking candidates were skipped,
without revealing private earnings to unauthorized roles. Examples:

- on approved break;
- service not enabled for this technician;
- insufficient time before 2:30 PM appointment;
- customer requested another technician;
- active refusal penalty;
- within fairness band, later in queue.

## 6. Core user flows

### 6.1 Technician check-in

1. Technician enters PIN on phone or salon tablet.
2. TurnIQ records check-in time, queue order, policy version, and fairness
   baseline.
3. Receptionist/manager may check in a technician on their behalf.

### 6.2 Add walk-in

Required fields:

- customer name;
- service;
- party size.

Optional fields:

- phone;
- explicit requested technician;
- request source/note;
- service notes.

Any permitted technician may add the walk-in when no receptionist is present.
The person adding the customer cannot silently select themselves; choosing a
non-recommended technician is an audited override.

### 6.3 Recommend and assign

1. TurnIQ evaluates the active policy and current salon state.
2. Front Desk displays one recommended technician and a concise explanation.
3. User confirms or overrides with a reason.
4. NailIQ auto-selects a free chair/bed/room where resource mode is enabled.
5. Front Desk may change the resource.
6. Assignment appears on the shared board and technician view; connected devices
   receive a notification and the salon device may play a bounded sound.

### 6.4 Start and complete

- Technician starts service from Staff View.
- Technician completes service and confirms performed services/add-ons.
- Receptionist/owner can correct the record with a reason.
- Turn, credited revenue, resource state, and next recommendation update as one
  committed operation.

### 6.5 Customer ETA

- Display estimated wait time as a range, not a false exact promise.
- Recalculate on assignment, start, completion, cancellation, late service, or
  resource change.
- Customer-facing views do not show technician earnings or internal ranking.

## 7. Offline operation

Offline support is a V1 requirement, not a later enhancement.

### 7.1 V1 boundary

One owner-designated **Primary Offline Device** per salon may mutate the turn
queue while disconnected. Other disconnected devices show cached state and a
clear read-only banner. This boundary prevents multiple offline devices from
creating conflicting assignments without a shared authority.

The primary device supports offline:

- staff check-in/out;
- add walk-in;
- recommend and confirm assignment from cached policy/catalog/schedule;
- start and complete service;
- add permitted service/add-on;
- break/return;
- override with reason.

Unavailable while offline:

- SMS, email, push, AI voice, or provider calls;
- payment-provider operations;
- cross-device live sync;
- unverified changes to cloud-only appointments received after disconnection.

### 7.2 Sync requirements

- Every offline command has a device-generated UUID, salon ID, policy version,
  local sequence, timestamp, actor, and request fingerprint.
- Commands persist in an encrypted local outbox before the UI shows success.
- Reconnect replays commands idempotently in sequence.
- The server stores command receipts and returns the committed prior result on
  retry.
- A salon-scoped version/sequence detects cloud divergence.
- Conflicts never silently overwrite state; Front Desk receives a reconciliation
  task with both versions and a safe suggested resolution.
- Offline mode must not claim customer notifications or payment actions occurred.

## 8. Screens in V1

### Staff Check-in

- PIN entry;
- checked-in roster;
- break/return;
- connectivity and primary-device status.

### Front Desk Turn Board

- appointments, walk-ins, and in-service customers;
- recommended technician and explanation;
- queue position and status;
- chair/bed/room;
- accept, override, hold, start, and complete;
- offline and unsynced-command indicators.

### Staff View

- current status;
- own queue position and turn count;
- next assignment;
- explanation without private peer revenue;
- start/complete/add service;
- dispute flag.

### Customer Check-in / ETA

- QR/kiosk check-in;
- customer name, service, party size, requested technician;
- wait-time range;
- privacy-safe status.

### Owner Policy and Report

- policy template and scheduled effective date;
- fairness band and revenue basis;
- break/refusal/redo rules;
- daily turns, list-price revenue, actual service revenue where available, and
  tips;
- owner/receptionist-created requested bookings by technician;
- overrides, swaps, penalties, disputes, and offline reconciliation history.

## 9. Data model proposal

Final names require schema audit before implementation.

### `turn_policies`

- salon ID;
- active policy-version ID;
- template key;
- timezone/business-day reset rule.

### `turn_policy_versions`

- immutable JSON policy;
- created by/at;
- effective from;
- superseded by;
- change reason.

### `staff_shift_sessions`

- salon/staff;
- check-in/out;
- arrival ordinal;
- fairness baseline;
- status: active, break, hold, left;
- offline origin metadata.

### `turn_assignments`

- customer/booking/walk-in;
- recommended and assigned technician;
- policy version;
- decision inputs and explanation code;
- requested-tech source;
- override reason/actor;
- turn consumed;
- credited revenue basis and amount.

### `turn_events`

Append-only events including check-in, break, return, recommendation, assignment,
override, start, complete, refusal, penalty, swap, redo, correction, and reset.

### `offline_command_receipts`

- salon/device/command ID;
- request fingerprint and local sequence;
- committed result;
- reconciliation status.

## 10. Permissions and abuse controls

- Tenant scope and role checks apply to every read and mutation.
- Technicians may add customers but cannot silently self-assign.
- Requested-technician entries store source and actor.
- Excess requested-client creation by actor/technician is reported as an
  anomaly, not automatically labeled fraud.
- Owner corrections remain visible in append-only history.
- Policy changes are scheduled for the next shift/day by default.
- Emergency same-day changes require a reason and create a visible policy event.
- Exact peer revenue/tips remain owner/manager-only.

## 11. V1 scope

### Included

- Per-salon versioned policy engine.
- Money-Balanced Rotation template.
- Staff PIN check-in and shared queue.
- Skill, schedule, appointment-gap, and resource eligibility.
- Requested-tech provenance.
- Recommendation plus human confirmation.
- Audited override/swap/penalty/redo handling.
- Staff, Front Desk, customer ETA, and owner-report views.
- Primary-device offline operation and idempotent sync.
- Shadow/simulation mode.

### Explicitly excluded

- Full POS or payment terminal replacement.
- Payroll and tax filing.
- Commission payout.
- AI voice receptionist.
- Loyalty, gift cards, or broad marketing campaigns.
- Native iOS/Android apps; responsive web/PWA is sufficient for V1.
- Unrestricted multi-device offline writes.

## 12. Acceptance scenarios

1. Twelve technicians check in; queue order matches arrival order.
2. A late technician does not jump ahead because their revenue is zero.
3. A requested appointment assigns the requested technician, consumes a turn
   only after service, and records request provenance.
4. A requested customer no-shows; technician retains position and turn.
5. First technician lacks skill; they are skipped without penalty.
6. First technician has a 30-minute gap but service needs 45 minutes; they are
   skipped without losing position.
7. Technician on approved break returns to the preserved position.
8. Technician leaves without approval or refuses an eligible customer and moves
   to the end.
9. Two technicians serve manicure/pedicure concurrently; each receives one turn
   and their own service credit.
10. Four-person party receives four eligible assignments using revenue balance
    then queue order.
11. Customer rejects the recommendation; skipped technician is not penalized.
12. Owner overrides assignment; affected staff see the reason and history.
13. Receptionist adds a $20 upgrade; ranking credit updates immediately.
14. Internet fails for 30 minutes; primary device completes core flow, preserves
    commands across reload, and syncs once without duplicate assignments.
15. A second disconnected device cannot mutate the queue as if it were primary.
16. An owner-entered requested-tech phone booking appears in provenance and
    anomaly reporting.
17. Policy change made today takes effect next salon-local business day.
18. Customer ETA updates without exposing technician names, revenue, or queue
    internals.

## 13. Pilot and evidence plan

Pilot with one walk-in-heavy nail salon, not the two headspa customers alone.

### Week 1 — Shadow

- TurnIQ makes recommendations but humans continue the existing process.
- Compare recommendation, actual assignment, reason for divergence, and wait.
- Do not change live turn order automatically.

### Week 2 — Supervised

- Front Desk confirms recommendations.
- Owner reviews every override and offline reconciliation daily.

### Weeks 3–4 — Live pilot

- Salon uses TurnIQ as the primary turn record.
- Keep a documented recovery procedure, not an untracked parallel paper queue.

### Proposed success gates

- At least 90% of eligible assignments use a TurnIQ recommendation without an
  unexplained override.
- At least 90% of walk-ins are processed without a separate paper turn list.
- Median add-walk-in-to-confirmed-assignment time is under 15 seconds.
- Average customer wait improves relative to the shadow baseline; initial target
  is 20%, subject to baseline volume and staffing mix.
- Owner-reported active turn-management time improves relative to baseline;
  initial target is 70%.
- Zero duplicate assignments, lost offline commands, or silent policy changes.
- All overrides and requested-tech claims have actor/source provenance.
- Owner and staff complete an end-of-pilot trust review.

These targets are hypotheses until baseline data is captured.

## 14. Suggested build order

1. Policy schema, event ledger, deterministic engine, and simulator.
2. Shadow-mode evaluation against current Receptionist Center data.
3. Staff shift/PIN check-in and Front Desk recommendation UI.
4. Atomic confirm/start/complete and resource assignment.
5. Staff View, requested-tech provenance, override/dispute workflow.
6. Owner report and anomaly visibility.
7. Primary-device offline outbox, receipts, replay, and reconciliation.
8. QR/kiosk check-in and customer ETA.
9. Pilot hardening, observability, rollback, and evidence capture.

## 15. Pre-build gates

Before code changes:

- Start from a clean, current checkout and record branch/SHA.
- Re-audit existing Receptionist Center, walk-in, staff schedule, resource,
  feature-flag, and event-log contracts.
- Confirm production schema separately from migration files.
- Decide whether existing booking events can be extended safely or TurnIQ needs
  a dedicated append-only ledger.
- Produce an offline threat/concurrency model before enabling offline writes.
- Keep TurnIQ default OFF behind a per-salon feature flag.
- Do not enable it for a live salon until shadow evidence and rollback rehearsal
  pass.

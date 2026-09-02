# TurnIQ — “Wow” Research Brief

> Date: 2026-09-01
> Status: Competitive and design research; not an implementation claim
> Purpose: Find a defensible product wedge before TurnIQ engineering begins

## 1. Executive finding

TurnIQ will not be remarkable merely because it digitizes a turn list. Nail-salon
products already advertise live turn boards, points, break holds, skill matching,
self check-in, ticket ownership, payroll links, and staff apps.

The defensible opportunity is to build a **trusted floor operating system** that
solves four problems together:

1. Which eligible technician should receive this customer?
2. Why is that assignment fair?
3. How can the team challenge or correct it without returning to verbal disputes?
4. How does the salon continue operating when the Internet is unavailable?

The proposed flagship is:

> **TurnIQ Trust Engine** — revenue-balanced opportunity allocation with
> customer-request provenance, privacy-safe explanations, appeal/override,
> appointment/resource awareness, offline continuity, and policy replay.

This is more differentiated than “AI receptionist,” “online booking,” or “POS,”
which are increasingly common across salon platforms.

## 2. What the market already offers

The items below are vendor claims from public product pages, not hands-on or
production verification.

### DashBooking

Dash publicly advertises:

- online booking and salon calendar;
- POS and Clover integration;
- customer self check-in by app or QR;
- Reserve with Google;
- reminders and promotions;
- reporting, reviews, loyalty, and gift cards;
- an AI receptionist that answers calls and books, changes, or cancels
  appointments.

Sources:

- [DashBooking business features](https://www.dashbooking.com/business/features)
- [DashBooking AI receptionist](https://www.dashbooking.com/business/ai-receptionist)

The reviewed public pages do not document a detailed staff-turn fairness model,
requested-tech provenance, policy replay, contestability, or offline turn
continuity. Absence from public pages is not proof the product lacks them.

### Broad salon platforms

Fresha publicly documents resource assignment, group appointments, payment
policies, client profiles, commissions, smart reminders, and an intelligent
waitlist that can prioritize first-in-line, highest-value, or offer-to-all.

- [Fresha scheduling](https://www.fresha.com/for-business/features/scheduling)
- [Fresha waitlist configuration](https://www.fresha.com/help-center/knowledge-base/calendar/259-set-up-and-manage-your-waitlist)

Mangomint publicly documents an intelligent waitlist, group bookings, virtual
waiting room, client self check-in, and notifications to service providers.

- [Mangomint scheduling](https://www.mangomint.com/features/scheduling/)
- [Mangomint learning center](https://www.mangomint.com/learn/)

These systems set a high bar for customer booking, client waitlists, resources,
and calendar optimization. They do not establish that the internal staff turn
problem is solved for a walk-in-heavy nail salon.

### Nail-specific turn products

Publicly advertised specialist capabilities include:

- Fair Flow: shared live rotation, breaks without losing place, turn counts and
  history, and visible floor state.
- ABTurns: point/whole-turn/traditional modes, skill matching, reverse assignment,
  self check-in, multi-device boards, POS, payroll, and staff views.
- SpaOne: salon-defined turn rules, appointments plus walk-ins, multiple
  technicians per ticket, commission/tips, and customer preferences.
- Free Time POS: real-time turns, custom rules for breaks/late arrival/service
  type, payroll linkage, and kiosk check-in.

Sources:

- [Fair Flow turn system](https://www.fairflowapp.com/salon-queue-management)
- [ABTurns features](https://www.abturns.com/features)
- [SpaOne for nail salons](https://spaonepos.com/solutions/nail-salons)
- [Free Time POS](https://freetimepos.com/)

### Competitive conclusion

The baseline is no longer “show who is next.” To win, NailIQ must make fairness
more trustworthy and the combined appointment/walk-in operation more autonomous
than these visible alternatives.

## 3. White space: what could feel genuinely new

### 3.1 Opportunity fairness instead of turn counting

A simple count treats a $15 repair and a $120 full set as equal. A pure revenue
ranking lets a late arrival with $0 jump the line. Neither matches the salon rule
provided by the product owner.

TurnIQ should maintain two separate truths:

1. **Business truth:** service revenue, actual payment, tips, and commission.
2. **Fairness truth:** opportunity credit used only to recommend the next
   technician.

For the Money-Balanced template:

- one completed customer still consumes one turn;
- list-price service value updates opportunity credit;
- low-value work naturally gives the technician stronger priority for a later
  suitable opportunity;
- tips never affect ranking;
- a check-in baseline prevents late-arrival advantage;
- a salon-defined fairness band stops meaningless $1–$5 differences from
  constantly reordering the team.

This creates **automatic fairness recovery**: a technician who accepts the small
job is not punished for the rest of the day, without inventing a complicated
half-turn rule.

### 3.2 Trusted Request provenance

The product-owner interview identified a specific abuse pattern: an owner takes a
phone call, chooses a favoured technician, and records the appointment as if the
customer explicitly requested that technician.

TurnIQ should never display all “requested technicians” as equally verified.

Recommended provenance labels:

- **Customer-selected:** selected directly in public booking.
- **AI-confirmed:** caller explicitly selected the technician in a connected AI
  phone flow.
- **Staff-entered:** receptionist/owner says the caller requested the technician;
  actor and timestamp are retained, but the claim is not independently verified.
- **Imported:** source system supplied the request.
- **Override:** manager changed the system recommendation.

The owner report should show requested-client percentages by booking creator and
technician. It may flag an unusual pattern for review, but must not label a person
fraudulent without proof.

This is both a trust feature and a sales demonstration: “NailIQ does not accuse;
it makes every source visible.”

### 3.3 Explain, appeal, and correct

Research on algorithmic management warns that a black-box manager can reduce
fairness perceptions, while fully automated decisions are especially risky for
complex situations. Actionable transparency, human influence, and a way to
contest decisions matter more than exposing every internal number.

Relevant research:

- [Algorithmic decisions and procedural justice](https://doi.org/10.1016/j.giq.2020.101536)
- [Transparency and justice perceptions](https://www.sciencedirect.com/science/article/pii/S2451958822000793)
- [Algorithmic reductionism and procedural justice](https://doi.org/10.1016/j.obhdp.2020.03.008)
- [Class fairness in online matching](https://doi.org/10.1609/aaai.v37i5.25704)

TurnIQ should therefore provide three layers:

1. **One-line reason:** “Mai is qualified, free, inside the fairness band, and
   earlier in the active queue.”
2. **Why others were skipped:** break, skill mismatch, appointment gap,
   requested technician, or active penalty.
3. **Challenge:** affected technician can flag the assignment; manager resolves
   it without rewriting history.

Do not reveal exact peer revenue or the full score formula to every technician.
That can violate privacy, create gaming, and overwhelm the user. Show actionable
reason categories and the salon's agreed policy instead.

### 3.4 TurnIQ Replay and Policy Simulator

Before changing a live salon rule, the owner should be able to replay a previous
busy day using a candidate policy:

- current policy versus proposed policy;
- customer wait distribution;
- assignments by technician;
- opportunity-credit spread;
- appointment conflicts avoided;
- owner overrides that would have been needed;
- late-arrival and requested-tech effects.

This turns configuration into evidence instead of argument. It also creates a
product moat because every pilot produces better salon-specific policy data.

The simulator must be deterministic and must not mutate live data. V1 can replay
captured events; later versions can use discrete-event simulation for uncertain
service duration and walk-in arrival.

Service-operations research supports treating scheduled and unscheduled arrivals
as a combined allocation problem rather than two independent calendars:

- [Scheduled and unscheduled arrival design](https://doi.org/10.1016/j.peva.2014.06.003)
- [Appointment and walk-in allocation](https://doi.org/10.1016/j.cie.2021.107125)

### 3.5 No-Receptionist Autopilot

The interview salon has technicians manually dividing turns when no receptionist
is present. TurnIQ should be designed for that reality.

Recommended controls:

- any permitted technician may add a customer;
- the creator cannot silently assign the customer to themselves;
- system recommendation needs one tap;
- overriding to oneself requires a reason and, when configured, confirmation by
  another active technician or manager;
- staff receive a clear “your customer” notice;
- no exact peer revenue is exposed;
- unresolved acknowledgements return to the shared board rather than silently
  disappearing.

The “Wow” moment is not a dashboard. It is twelve technicians operating for an
hour without the owner deciding a single normal turn.

### 3.6 Customer Wait Confidence

Do not promise a false exact wait time. Service duration varies by technician,
service complexity, add-ons, and late appointments.

V1 should show a range, for example “about 15–25 minutes,” and update it when a
service starts, ends, upgrades, or changes technician/resource. The customer sees
progress and ETA but not internal staff ranking.

Research on wait information is mixed; merely displaying an estimate does not
guarantee satisfaction. The product should measure estimate accuracy and customer
abandonment rather than assume the feature works.

- [Randomized wait-estimate study](https://pmc.ncbi.nlm.nih.gov/articles/PMC11864359/)
- [Waiting-time information and queue behavior](https://doi.org/10.1016/j.ejor.2008.09.040)

Future versions can learn technician-service duration distributions after enough
clean completion data. Until then, use catalog duration, buffer, active progress,
and a conservative confidence range.

### 3.7 Fair group and multi-service matching

For one customer, lexicographic deterministic ranking is explainable and fast.
For a group or simultaneous manicure/pedicure, greedy assignment can choose the
wrong first technician and make the remaining combination impossible.

Recommended approach:

- single customer: deterministic constraint filter plus ranked selection;
- simultaneous group: constrained bipartite matching/min-cost assignment;
- multiple stages: dependency-aware plan using staff and resources;
- objective order: feasibility, requested-tech constraint, appointment safety,
  customer wait, fairness cost, then stable tie-break.

This builds on NailIQ's existing group scheduler and resource layer rather than
starting from zero.

## 4. The five “Wow” experiences

### Wow 1 — “Why Mai?”

Front Desk displays the recommendation and a privacy-safe reason. Any staff
member can understand the decision in seconds.

### Wow 2 — “Prove last Saturday”

Owner replays a historical rush under two policies and sees which one reduces
wait without creating unfair opportunity distribution.

### Wow 3 — “The owner left the desk”

Technicians add customers, TurnIQ recommends, the team confirms, and only
exceptions reach the owner.

### Wow 4 — “The Internet went down; the queue did not”

The designated salon device remains functional, visibly records unsynced
commands, and reconciles once without duplicate turns.

### Wow 5 — “Requested by whom?”

Every requested-tech claim shows source and trust level. Owner-entered phone
requests are visible without pretending they were independently verified.

## 5. Offline architecture research

### 5.1 Current NailIQ gap

The current service worker is network passthrough only and intentionally caches
nothing. The current walk-in form locks mutations when offline. Existing booking
audit writes are best-effort and can fail without rolling back the mutation.

Relevant local evidence:

- `public/nailiq-sw.js`
- `src/components/receptionist/WalkinAddForm.tsx`
- `src/shared/dashboard/auditLog.ts`

Therefore offline TurnIQ is a new subsystem, not a UI toggle.

### 5.2 Browser building blocks

- IndexedDB supports structured transactional local data and is designed for
  offline use.
- Service workers and Cache Storage can make the application shell available
  offline.
- Background Sync/Workbox can persist failed requests in IndexedDB and retry,
  but browser scheduling is not guaranteed and must not be the only recovery
  mechanism.
- Persistent storage can be requested, but the browser decides whether to grant
  it.
- Web Locks can coordinate tabs on one physical device, not separate devices.

Sources:

- [MDN IndexedDB guide](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB)
- [Workbox Background Sync](https://developer.chrome.com/docs/workbox/modules/workbox-background-sync)
- [StorageManager persistence](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager)
- [Web Locks specification](https://w3c.github.io/web-locks/)
- [Background Sync limitations](https://github.com/WICG/background-sync/blob/main/explainers/sync-explainer.md)

### 5.3 Recommended safety model

Use a single owner-designated **Primary Offline Device** as the only disconnected
writer for V1.

Components:

1. Cached, versioned salon snapshot: policy, services, staff, capabilities,
   appointments, resources, and active turn state.
2. IndexedDB append-only command outbox.
3. Every command persisted before UI success.
4. UUID, salon, device, local sequence, policy version, actor, timestamp, and
   request fingerprint on every command.
5. Atomic server command receipt and domain mutation.
6. Replay returns the previously committed result for duplicate command IDs.
7. Server sequence detects divergence.
8. Manual reconciliation queue for genuine conflicts.
9. Visible offline/unsynced count at all times.
10. Exportable emergency snapshot/print view.

Do not use a multi-device CRDT for V1 assignment state. Two offline devices can
validly make mutually incompatible decisions, such as assigning the same
technician to two customers. That conflict cannot be made safe by merging both
events after the fact.

### 5.4 Atomic fairness ledger

The current best-effort booking audit log is useful for activity visibility but
is insufficient as the authoritative fairness ledger. If assignment commits and
the fairness event fails, the next recommendation can be wrong.

TurnIQ requires one server transaction/RPC that commits together:

- assignment or status transition;
- turn state;
- opportunity credit;
- resource occupancy;
- immutable decision/override event;
- idempotent command receipt.

## 6. Algorithm proposal

### 6.1 Do not start with machine learning

The assignment engine should be deterministic in V1. Machine learning may later
estimate service duration, arrival patterns, or no-show risk, but must not secretly
decide fairness.

### 6.2 Single-customer decision

Use a lexicographic decision, not one opaque blended AI score:

1. Validate salon, policy version, customer, service, and active state.
2. If customer-requested, evaluate requested technician feasibility.
3. Build eligible technician set.
4. Remove schedule/resource-infeasible candidates.
5. Apply policy holds/penalties.
6. Compare fairness credit using the salon's fairness band.
7. Break a fairness-band tie with active queue order.
8. Use a stable technical tie-breaker.
9. Return recommendation, skipped-reason codes, and decision fingerprint.

### 6.3 Group decision

Build a candidate graph:

- left nodes: customer/service tasks;
- right nodes: eligible technician/time/resource combinations;
- edges: feasible assignments;
- edge cost: wait, appointment risk, fairness debt, preference deviation, and
  stable tie-break.

Solve a constrained minimum-cost matching. Persist the complete proposed plan and
revalidate atomically at confirmation time.

### 6.4 Fairness is measured over opportunity, not guaranteed pay

TurnIQ cannot guarantee equal earnings because requested clients, skill sets,
hours worked, speed, upsells, and tips differ. Product language must say:

> “NailIQ applies the salon's agreed opportunity rules consistently and records
> every exception.”

Never promise equal pay or perfect fairness.

## 7. Product prioritization

| Capability | Customer impact | Defensibility | Existing NailIQ leverage | Recommendation |
| --- | --- | --- | --- | --- |
| Explainable fair recommendation | Very high | High | Queue, schedules, resources | Build first |
| Requested-tech provenance | High | High | Existing request fields/audit | Build first |
| Atomic fairness ledger | Very high | High | Existing events need strengthening | Build first |
| Shadow replay/simulator | High | Very high | Existing event data foundation | Build first |
| No-receptionist workflow | Very high | High | Receptionist Center/roles | Build first |
| Primary-device offline mode | Very high | High | PWA shell only; major new work | Build after engine |
| Wait confidence range | High | Medium | Durations/status events | Build in pilot |
| Group/multi-service optimization | High | High | Group/resource scheduler | Build after single flow |
| AI receptionist | Medium-high | Medium | Existing Beta voice code | Later add-on |
| POS/payroll | Medium | Low for differentiation | Integration work incomplete | Integrate later |
| Loyalty/marketing | Medium | Low | Beta modules | Defer |

## 8. What not to build

- No black-box AI assignment.
- No leaderboard that exposes exact peer earnings.
- No public customer view of technician ranking.
- No “fairness percentage” without a precise, reviewable definition.
- No automatic accusation of owner favouritism.
- No fully automatic assignment before shadow evidence and staff trust.
- No unrestricted multi-device offline mutation.
- No POS/payroll expansion before TurnIQ pilot proves the floor workflow.
- No gamification that rewards rushing, upselling, or avoiding difficult work.

## 9. Revised build sequence

### Phase A — Trust foundation

1. Dedicated atomic fairness ledger and policy versions.
2. Pure deterministic decision engine.
3. Requested-tech provenance.
4. Explanation and skipped-reason contract.
5. Historical scenario fixture generator.

### Phase B — Replay before control

1. Shadow engine reads current Receptionist Center state.
2. TurnIQ Replay compares recommendation with actual assignment.
3. Owner tunes fairness band and rules without live mutation.
4. Record baseline wait, owner intervention, and exception reasons.

### Phase C — No-receptionist operation

1. PIN check-in.
2. Quick add customer.
3. Recommendation/confirm.
4. Start/complete/add service.
5. Self-assignment override control.
6. Staff challenge and owner resolution.

### Phase D — Offline continuity

1. Cache application shell and salon snapshot.
2. Primary-device designation and Web Lock tab leadership.
3. IndexedDB outbox and persistent-storage request.
4. Atomic command receipt/replay.
5. Reconciliation UI and destructive outage tests.

### Phase E — Customer flow optimization

1. Conservative wait range.
2. Group constrained matching.
3. Multi-service/staff/resource plan.
4. Historical duration learning only after data-quality gates.

## 10. Pilot design

Use one walk-in-heavy nail salon with approximately the interview profile. Do not
start by activating automatic assignment.

### Baseline week

- Capture actual check-ins, appointments, walk-ins, assignments, start/completion,
  overrides, claimed requests, and owner intervention minutes.
- Keep current operational method.

### Shadow week

- Generate recommendations with no operational control.
- Ask “Would you accept this?” and record the exact rejection reason.
- Replay the day under alternative fairness bands.

### Assisted weeks

- Human confirms every recommendation.
- Owner reviews requested-tech provenance and disputes daily.
- Run planned Internet-loss exercises on non-payment workflows.

### Primary measures

- owner minutes spent deciding normal turns;
- add-customer-to-assignment time;
- actual customer wait distribution, not only average;
- recommendation acceptance rate;
- overrides with and without documented operational reason;
- opportunity-credit spread among comparable eligible hours;
- staff trust survey and dispute count;
- lost/duplicate offline commands;
- walk-aways before assignment.

## 11. Go/no-go standard

TurnIQ is “Wow” only if the pilot demonstrates all of the following:

1. The owner can leave normal turn decisions to the team/system.
2. Wait improves without harming booked appointments.
3. Staff can understand and challenge decisions without seeing private earnings.
4. Requested-tech provenance makes exceptions more trustworthy.
5. Offline continuity loses or duplicates no committed turn command.
6. The policy simulator predicts the effect of rule changes well enough to guide
   the owner.

Until then, the correct claim is “TurnIQ pilot,” not “the fairest salon system.”

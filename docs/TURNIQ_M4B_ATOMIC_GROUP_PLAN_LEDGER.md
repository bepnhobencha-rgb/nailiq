# TurnIQ M4B — Atomic Group Plan Ledger

Status: `LOCAL_POSTGRES_TESTED_NOT_DEPLOYED`

TurnIQ remains behind `turniq_trust_engine_enabled`; every salon remains OFF.
This milestone did not create a real booking, call a provider, send a message,
apply QA/Production, commit or push.

## Outcome

M4A's deterministic 2–12 guest plan can now be recorded as one authoritative
group plan without assigning any booking. Each member links to its own TurnIQ
assignment, active shift, booking, proposed technician/resource, safe service
window and server-computed material booking fingerprint.

`confirm_turniq_group_plan_v1` then locks and revalidates the whole plan before
changing anything:

- exact active group membership and policy/business day;
- booking status, service, add-on, time, schedule model and resource;
- active technician and TurnIQ shift;
- main-service and add-on capability;
- catalog-derived safe end before the next appointment;
- active resource and current staff/resource capacity;
- requested-technician fallback reason;
- command identity and request fingerprint.

Only after every member passes does one transaction confirm all assignments,
assign all bookings, create one Fairness Receipt per member, store the command
receipt and append the group-plan event. One stale member rolls back the whole
group. Retrying the same command returns its committed result without duplicate
assignments, receipts or events.

## Security and concurrency boundary

- Tables have forced RLS and no browser-role grants.
- RPCs are `SECURITY INVOKER` and executable only by `service_role`.
- Group item inputs are immutable after insert.
- Locks reuse NailIQ's established staff/resource capacity namespaces in stable
  order.
- The existing booking exclusion and operational-capacity triggers remain
  active; no tenant, booking or resource guard was disabled.
- Group assignment rows are confirmed only after all revalidation passes. This
  intentionally prevents the existing single-booking trigger from trying to
  compare one group member against a snapshot changed by another member in the
  same transaction.

## Local evidence

- Migration applied cleanly to a cloned disposable PostgreSQL database.
- Two-person recommendation persisted two ledger items and did not mutate
  bookings: PASS.
- Atomic confirmation assigned both bookings and created exactly two Fairness
  Receipts plus group events: PASS.
- Identical recommend/confirm command retry returned replay truth and created no
  duplicates: PASS.
- Removing one technician's skill after recommendation rejected confirmation
  and left every group booking/assignment unchanged: PASS.
- ACL/RLS and service-only execution checks: PASS.

## Superseded next boundary

- M4C now supplies the Server Action/read model binding in
  `docs/TURNIQ_M4C_TRUSTED_GROUP_SERVER_BOUNDARY.md`.
- Receptionist Center group-confirm UI and Fairness Receipt group view.
- Staggered waves, arrive-together/finish-together policies and multi-stage
  technician handoff.
- QR/kiosk check-in, realtime ETA, offline continuity, QA, Preview, Production
  or pilot proof.

The next safe milestone after M4C is M4D: Receptionist Center group-plan UI.

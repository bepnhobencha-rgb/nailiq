# TurnIQ M4C — Trusted Group Server Boundary

Status: `LOCAL_TESTED_NOT_DEPLOYED`

TurnIQ remains behind `turniq_trust_engine_enabled`; every salon remains OFF.
This milestone did not apply a migration, mutate QA/Production, create a real
booking, call a provider, send a message, commit or push.

## Outcome

M4A and M4B are now connected through a server-owned boundary:

1. The browser supplies only salon slug, booking-group ID and exactly-once
   command envelope.
2. The server re-authorizes the signed-in salon member and desk role.
3. The adapter returns an already committed command before loading mutable
   salon state.
4. It reloads salon timezone, effective TurnIQ policy, exact active group
   membership, services/add-on catalog, active staff, shifts, capabilities,
   bookings, service segments and resources.
5. A pure trusted snapshot excludes customer PII, notes, payment, tax and tips,
   then runs the deterministic M4A constrained matcher.
6. Only a complete exact-slot plan is sent to the service-only M4B RPC.
7. Confirmation reloads the group plan, requires a reason for any requested-tech
   fallback and delegates all-or-nothing revalidation/commit to M4B.
8. The read action returns a privacy-safe desk projection with technician,
   service, resource, time, ETA, owner-action truth and Fairness Receipt IDs.

## Fail-closed boundaries

- Mixed start times, a preassigned group member, unsupported `booking_addons`,
  booking service segments, missing policy or incomplete group membership are
  rejected.
- The legacy booking boolean cannot prove requested-technician source, actor or
  timestamp. M4C does not invent provenance or grant request precedence.
- M4A may model a later feasible start, but M4B currently preserves existing
  booking times. M4C rejects any shifted member instead of silently rescheduling
  a customer. Staggered waves belong in an explicit later contract.
- The M4B ledger has one resource slot per booking. A task requiring more than
  one simultaneous resource is rejected.
- A preselected booking resource is authoritative. If none exists, the trusted
  planner may select one; M4B rechecks it under the same confirmation locks.

## Privacy and security

- `serverActions.ts` validates every request before delegation.
- `trustedGroupRecommendation.ts` is marked `server-only`.
- Browser input cannot contain recommended technician, resource, policy,
  objective score, snapshot or decision trace.
- Every query and RPC is explicitly salon-scoped after server-side membership
  resolution.
- Desk projection omits customer PII, peer money, tips, fairness objective
  costs, fingerprints and internal traces.
- Recommendation and confirmation retry use the existing command receipt before
  mutable reads, preserving exactly-once success truth.

## Local evidence

- Pure trusted two-person snapshot produced a complete stable staff/resource
  match: PASS.
- Busy staff and occupied resource availability were derived server-side: PASS.
- Mixed slots, preassignment and segmented group members failed closed: PASS.
- Privacy-safe projection omitted financial/internal/customer truth: PASS.
- Static server-boundary checks proved identifier-only input, server-only
  adapter, authorization and M4A→M4B delegation: PASS.
- TypeScript typecheck and focused TurnIQ/security tests: PASS.

## Superseded next boundary

- M4D now supplies the Receptionist Center card and safe group-plan actions in
  `docs/TURNIQ_M4D_RECEPTIONIST_GROUP_PLAN.md`.
- Persisted requested-tech provenance for group booking intake.
- Staggered waves, arrive-together/finish-together policy, multi-resource tasks
  or in-progress multi-tech handoff.
- QR/kiosk check-in, realtime ETA updates, offline continuity, QA, Preview,
  Production or pilot proof.

The next safe milestone after M4D is M4E: explicit group timing intent and
staggered-wave simulation before mutation.

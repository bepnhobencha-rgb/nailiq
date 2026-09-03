# TurnIQ M4S — Trusted multi-service handoff bridge

Status: implemented and tested locally only. Not committed, published, migrated
to QA, deployed, production-verified, salon-enabled, or pilot-proven.

## Boundary

- The browser supplies only salon slug, booking/plan/performer identifiers, and
  an idempotent command envelope.
- The trusted server reloads salon, effective TurnIQ policy, committed booking
  segments, shifts, staff skills, occupied intervals, resources, and certified
  parallel-service policies.
- The deterministic engine evaluates each segment independently. Staff busy
  windows prevent an appointment between two service segments from being
  treated as either all-day free or all-day busy.
- Booking scheduling remains authoritative. If the deterministic recommendation
  differs from a committed segment's staff, resource, or time, the bridge stops
  with stale state. It never silently rewrites the booking.
- Recommendation, confirmation, and performer start/complete call only the
  service-role handoff RPCs created by M4R. Supervised/LIVE rollout stage is
  required for every mutation.
- Read models omit customer PII, peer financial values, objective scores,
  fingerprints, and the internal decision trace.

## Supported server operations

1. Recommend a plan for an existing `segments_v1` booking whose committed
   assignment already matches the deterministic result.
2. Confirm the whole plan, with Owner/Admin review when requested-tech fallback
   exists.
3. Start or complete each actual performer independently.
4. Load a privacy-safe plan and today's multi-service handoff queue.

## Still intentionally blocked

- Reassigning a committed segment to a different recommended technician. That
  needs a separate canonical booking-capacity reschedule command and explicit
  audit semantics; this bridge refuses to improvise it.
- QA/Preview, Production migration, salon enablement, providers, payments, or
  notifications.

## Local verification

```bash
npx vitest run src/shared/turniq/__tests__/trustedHandoffSnapshot.spec.ts \
  src/shared/turniq/__tests__/multiTechnicianHandoffEngine.spec.ts \
  src/shared/turniq/__tests__/multiTechnicianHandoffEngine.invariants.spec.ts \
  src/shared/security/__tests__/turniqTrustedHandoffServerBoundary.spec.ts
npm run typecheck
```

## M4T local Front Desk evidence

- The existing TurnIQ read gate loads a PII-free multi-service queue.
- The card shows which technician owns each service segment and its resource.
- One confirmation creates one Fairness Receipt per actual performer.
- Start/complete acts on one performer at a time; success survives a read-back
  refresh failure and retries reuse the same command envelope.
- Synthetic loopback browser flow passed: recommendation, confirm two receipts,
  start/complete both performers, zero runtime overlay, zero clean-tab console
  errors, and no horizontal overflow at 390px width.
- This remains local evidence only; it is not QA, Preview, Production, or salon
  proof.

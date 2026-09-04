# TurnIQ M3I — Staff PIN Check-in

Status: implemented locally and applied to disposable QA; not applied to
Production; no live salon enabled.

## Outcome

TurnIQ now has a shared-device technician PIN boundary for shift presence. The
authenticated NailIQ account remains the accountable device actor, while the
PIN identifies the technician who is checking in, checking out, starting an
approved break, or returning from break.

Owner/Admin can configure or rotate a 4–8 digit PIN. Receptionists can use the
shared check-in surface but cannot set PINs. Nail technicians may authenticate
only their own shift when their signed-in membership is linked to that staff
record. Existing Owner/Receptionist check-in-on-behalf remains available and is
still attributed to the signed-in actor.

## Safety boundary

- TurnIQ salon flag must be enabled.
- PIN shift mutation requires `SUPERVISED` or `LIVE`; `SHADOW` remains read-only.
- Offline PIN mutation is not claimed. The UI is explicitly read-only offline.
- Raw PINs are never stored, written to receipts, or included in fingerprints.
- PostgreSQL stores a bcrypt hash through `pgcrypto` with cost 12.
- Five failed attempts lock that staff PIN for ten minutes.
- Credentials and receipts use forced RLS and have no `anon` or `authenticated`
  table access.
- Both RPCs are service-role-only. They still validate authoritative membership,
  role, salon, staff status, rollout stage, and policy state.
- The shift mutation delegates to the existing atomic TurnIQ shift command.
- Every successful PIN shift writes an immutable receipt linking the signed-in
  actor, technician, command, policy version, and request fingerprint.
- This milestone performs no payment, provider, booking, or notification call.

## Rollback

Set the salon rollout stage to `OFF` and stop presenting/calling the two PIN
RPCs. Preserve credential configuration and shift receipts as audit evidence;
do not drop them during an incident.

## Evidence boundary

Disposable QA evidence on `osdqutwunokiielbairj`:

- migration applied successfully, including the additive composite-FK covering
  index hotfix;
- all three tables use forced RLS; `anon` and `authenticated` have no direct
  table access or RPC execute privilege;
- Owner PIN setup/rotation succeeds, while Receptionist PIN setup is rejected;
- five incorrect attempts lock the PIN for ten minutes, and Owner rotation
  clears the lock without exposing the bcrypt hash;
- exact retry returns the prior committed result and leaves exactly one PIN
  receipt, command receipt, and immutable event;
- two concurrent check-ins for one technician create exactly one open shift and
  one durable receipt; the competing command fails closed;
- local browser tests pass on desktop Chromium and mobile WebKit, including an
  ambiguous-response retry that preserves the original command ID;
- a 12-staff synthetic browser rehearsal preserves exact arrival order on both
  desktop and mobile; an approved break and return keep staff number 5 in queue
  position 5;
- a disposable-QA transaction checks in 12 synthetic staff in exact positions
  1–12, preserves staff number 5 at position 5 through approved break/return,
  verifies 14 PIN receipts and 14 immutable events, and rolls back with zero
  synthetic rows remaining;
- ten TurnIQ database lifecycle fixtures pass in self-rolling-back transactions;
  QA security and performance advisors report no TurnIQ WARNING/ERROR findings;
- no payment, booking, provider, or notification call was made.

QA evidence is not Production or pilot proof. Preview verification, physical
tablet usability, and a supervised salon pilot are still required before this
capability can be called Production-verified or pilot-proven.

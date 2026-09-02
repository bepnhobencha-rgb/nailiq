# TurnIQ M3B Server Boundary and Read Models

Status: `implemented locally` and `tested locally`. Nothing in this milestone
has been committed, pushed, applied to QA/Production, deployed, or enabled for
any salon. TurnIQ remains default OFF.

## What M3B adds

M3B connects the M3A atomic RPC boundary to authenticated server-only code:

- validated Server Actions for shift and assignment commands;
- server-derived salon, actor, role, timestamp, and command fingerprint;
- service-role access isolated in a `server-only` Data Access Layer;
- a server-only recommendation persistence primitive that cannot be called by
  browser code with a client-selected technician;
- minimal read projections for the Live Board, the logged-in technician's own
  Staff View, Fairness Receipt, and Owner Exception Inbox.

The browser supplies only identifiers, the semantic command, a durable command
ID, device ID, and local sequence. It never supplies its own actor, membership,
salon ID, timestamp, command fingerprint, or authorization role.

## Authorization and privacy

Every action revalidates the active authenticated session and exact salon
membership through the existing dashboard boundary. Demo-cookie access is not
accepted. The per-salon TurnIQ flag must be explicitly ON before any command or
read proceeds; default OFF remains fail-closed.

- Owner/Admin: operational projections, Exception Inbox, and the authorized
  financial/fingerprint portion of a Fairness Receipt.
- Senior/Receptionist: operational Live Board and privacy-safe receipts, but no
  peer financial truth or internal decision trace.
- Nail technician: own shift, own start/complete, own Staff View, and own
  privacy-safe receipt only.

The Staff View never returns peer opportunity credit, peer revenue, tips,
fairness-band amounts, command fingerprints, decision fingerprints, or the
internal decision trace.

## Read-model behavior

The Live Board projection makes the oldest safe pending recommendation the
next recommendation, shows privacy-safe skipped reasons, and explicitly says
when the team may continue without owner action. Routine work does not enter
the Exception Inbox; only open or acknowledged exception records do.

The Fairness Receipt has two shapes: the shared privacy-safe receipt, and an
Owner/Admin-only detail containing the fairness band, own authoritative
assignment financial truth, and immutable fingerprints.

## Local verification

- Server action core: malformed input, unauthenticated caller, feature OFF,
  own-staff boundaries, server-owned fingerprint/timestamp, idempotent retry
  material, and Owner confirmation conflict.
- Read projections: dominant next recommendation, skipped reasons, Owner
  Freedom empty state, Staff View privacy, role-shaped Fairness Receipt, and
  actionable-only Exception Inbox.
- Static security boundary: `use server` actions stay thin and validated;
  privileged code stays `server-only`; recommendation persistence is not a
  browser-callable action.
- TypeScript strict check passes.

## Deliberate limitations / M3C boundary

- No UI component or realtime subscription consumes these projections yet.
- A trusted Receptionist snapshot builder must still load the booking, active
  policy, shifts, capabilities, resources, and appointment gaps before calling
  the server-only recommendation writer.
- Customer wait range, one-tap Why-not-me, disputes, swaps, redo/refusal, and
  the 60-second demo remain later work.
- Group/multi-service matching remains M4; offline writes remain M5.
- No SMS, email, push, voice, payment, Square, or Stripe path is called.

## Rollback boundary

1. Keep `turniq_trust_engine_enabled` absent or false.
2. Do not import the M3B Server Actions into a live UI.
3. Preserve existing TurnIQ command/event/receipt/exception evidence.
4. Continue using the existing Receptionist Center lifecycle unchanged.

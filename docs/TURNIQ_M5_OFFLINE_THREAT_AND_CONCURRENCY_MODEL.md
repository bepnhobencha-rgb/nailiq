# TurnIQ M5 — Primary Offline Device threat and concurrency model

Status: implementation contract; local/QA only. This document does not enable
offline writes or any salon.

## Safety boundary

TurnIQ permits exactly one owner-designated Primary Offline Device per salon.
Only that device may queue the limited operational commands listed below while
the origin is unreachable. Every other disconnected device is cached read-only.
Online authorization, tenant scope, active policy, command idempotency and
assignment/resource validation remain authoritative after reconnect.

Permitted offline commands:

- staff check-in/check-out, approved break and return;
- confirm the server-verified recommendation cached before the outage, or
  override it with a reason;
- start and complete an already-cached assignment;
- add a PII-free walk-in ticket to a local intake queue; after reconnect it
  becomes a waiting booking and online TurnIQ computes the recommendation;
- one zero-duration add-on update represented in the cached snapshot. Timed or
  multi-add-on changes require online schedule/resource revalidation.

Forbidden offline claims or effects:

- SMS, email, push, AI voice, payment or provider success;
- a cloud booking, calendar or resource change already synchronized;
- owner approval, policy edits, device pairing/revocation or role changes;
- writes by a second disconnected device;
- silent conflict resolution or last-write-wins replacement.

## Trust assets

1. Salon isolation and authenticated actor/role.
2. Exactly-once command identity and ordered local sequence.
3. One active Primary Offline Device lease per salon.
4. Immutable TurnIQ events, command receipts and Fairness Receipts.
5. Cached server-verified board, policy, limited catalog and snapshot fingerprint.
6. Encrypted browser outbox and visible unsynced/conflict count.

No payment credentials, provider tokens, customer contact details or peer
financial amounts belong in the offline snapshot or outbox.

## Threats and controls

| Threat | Control | Failure behavior |
| --- | --- | --- |
| Stolen/copied browser storage | Non-extractable AES-GCM key in IndexedDB; encrypted payloads; server checks authenticated actor and active device lease | Revoke device; server rejects further replay |
| Two devices believe they are primary | Database partial unique constraint plus rotating lease generation | Second device is read-only; stale generation becomes a conflict |
| Repeated tap or lost response | Device UUID + monotonic sequence + command UUID + request fingerprint; existing immutable command receipt | Return prior committed result; never duplicate a turn/event |
| Reordered replay | Server requires the next acknowledged sequence; client replays one ordered command at a time | Stop at first gap and create reconciliation task |
| Cloud state changed while offline | Each command carries snapshot state version and policy version; server locks salon device state before validation | Stop before mutation; explicit stale-snapshot conflict |
| Policy changed while offline | Exact policy version required and revalidated | Conflict; owner refreshes and re-simulates |
| Staff/resource/appointment drift | Existing atomic assignment RPC revalidates shift, skill, gap, resource and assignment state | Whole command rolls back |
| Browser reports online behind captive portal | Origin health probe and actual replay response, not `navigator.onLine` alone | Keep queued; do not claim sync |
| IndexedDB quota/transaction failure | Persist and read-back before showing offline success | Command is not shown as accepted; UI blocks further mutation |
| Malicious payload or command kind | Closed Zod discriminated union and server-owned identifiers/snapshot | Reject as invalid; no provider fallback |
| Cross-tenant device ID reuse | Device identity and command receipt are both salon-scoped | Reject as forbidden/conflict |
| Service-worker stale application shell | Versioned cache; network-first navigation; cache only same-origin static shell; no API/Server Action response caching | Show explicit stale/offline state and require refresh before new online writes |

## Concurrency protocol

1. Pairing is online and Owner/Admin-only. Pairing creates a new generation and
   atomically revokes the previous primary device.
2. A synchronized snapshot records salon state version `N`, device generation,
   policy version and snapshot fingerprint.
3. Before offline success is displayed, the command is encrypted and committed
   to IndexedDB with expected state version `N + pending_command_count`.
4. Replay is ascending by local sequence and sends one command at a time.
5. The server locks the salon offline-state row, verifies active primary device,
   generation, expected state version, policy version and next sequence, then
   invokes the existing atomic domain command.
6. Exactly one immutable command receipt advances the salon state version by
   one. A retry with the same command/fingerprint returns the previous result.
7. Any version, fingerprint, permission or transition mismatch creates an open
   reconciliation item and stops later commands. Nothing is overwritten.
8. The UI may clear encrypted payload only after the committed receipt is
   acknowledged locally. Conflict evidence remains until Owner/Admin resolves it.

## Outage and destructive tests required before enablement

- lose network before persistence, after persistence, during request upload and
  after server commit but before response;
- reload/terminate the browser with one and multiple queued commands;
- replay the same command and the same sequence with a different fingerprint;
- attempt writes from a second, revoked or wrong-salon device;
- change policy, appointment, resource and staff shift while primary is offline;
- exhaust IndexedDB quota, delete the encryption key and corrupt ciphertext;
- reconnect behind a captive portal and with intermittent origin failures;
- update the service worker while commands are pending;
- verify provider calls and customer/staff notifications remain zero.

## Recovery and rollback

The M5 runtime is gated by the existing TurnIQ salon flag plus an active primary
device lease. Revoking the lease immediately returns every device to read-only
offline mode without deleting evidence. The additive schema can remain dormant.
Rollback never deletes command receipts, TurnIQ events, Fairness Receipts or
reconciliation history.

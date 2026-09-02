# TurnIQ M4L — QR/Kiosk Customer Check-in Shadow

Status: **implemented, unit-tested and browser-tested locally only**. Not
committed, not deployed, not connected to QA/Production, and not pilot-proven.

## Existing boundary found in the audit

NailIQ already has:

- QR links for booking and customer status;
- a receptionist-created walk-in flow;
- capability-token booking status;
- TurnIQ deterministic single/group engines and conservative ETA projection.

It did not have a safe public QR/kiosk check-in boundary. A salon slug or a
guessable public URL must not be enough to create a booking, insert a walk-in,
claim customer-request provenance, or assign a technician.

## Local implementation

M4L adds a pure deterministic, PII-free intake receipt for:

- booked customer versus new walk-in;
- QR versus shared kiosk;
- one to twelve guests;
- selected service;
- an optional technician explicitly selected by the customer.

Each receipt has a client command UUID, SHA-256 actor reference, deterministic
intake fingerprint, requested-tech source/trust label, and a machine-readable
next route. It is always marked `shadowOnly: true` and cannot mutate a booking,
queue, assignment, resource, provider, or notification.

Routing is explicit:

- booked single → single-engine candidate;
- booked group → constrained group optimizer;
- direct technician choice → requested-tech availability validation;
- new walk-in → identity matching before any booking creation.

The reusable UI tells customers that no appointment has changed yet. Offline
mode disables submission and never claims a check-in succeeded.

## ETA accuracy instrumentation

M4L also creates a deterministic privacy-safe observation from a previously
issued ETA and actual service start. It records only:

- estimate and observation fingerprints;
- observed start timestamp;
- early / within range / late;
- deviation and predicted range width.

It carries no salon, booking, customer, technician, resource, revenue, tip or
queue identifiers. Persistence is deliberately deferred until a tenant-scoped,
idempotent server command exists.

## Browser evidence

The loopback-and-test-flag-only harness covers:

1. booked single;
2. group routing;
3. customer-selected technician provenance;
4. walk-in identity boundary;
5. truthful offline blocking.

All five scenarios pass on desktop Chromium and mobile WebKit. A separate
Chrome visual check confirmed meaningful content, no Next.js error overlay and
no console errors. The harness uses no database or provider.

## Supabase/security decision

Current Supabase RLS guidance was reviewed. No public table, anon grant or
migration was added in M4L. The next server milestone must use a server-only,
salon-scoped capability, explicit grants/RLS, idempotent command receipt and
rate limiting before this UI can leave shadow mode.

## Rollback

Remove the local harness/component and pure contracts. No database or live
state rollback is required.

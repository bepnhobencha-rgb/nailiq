# TurnIQ M4J — Conservative Customer ETA Contract

Status: `IMPLEMENTED_AND_TESTED_LOCAL_NOT_INTEGRATED`

TurnIQ remains default OFF for every salon. This milestone did not commit,
push, apply QA/Production, mutate a booking, call a provider or send a message.

## Existing before this milestone

NailIQ already has a public customer wait page with realtime refresh plus a
30-second polling fallback. Its waiting estimate currently falls back to
`queue position × service duration` and displays one exact minute value. That
surface is useful, but it is not yet TurnIQ-aware and may communicate more
precision than the available operational data supports.

## Local implementation

M4J adds a pure deterministic customer ETA boundary that accepts only:

- snapshot identity and capture time;
- explicit visit status;
- party size;
- the existing server-owned TurnIQ conservative ETA;
- freshness (`fresh` or `offline_last_known`).

It cannot accept customer identity, booking/staff IDs, queue position, peer
money, tips or fairness credit.

The projection:

- rounds outward to five-minute boundaries;
- always returns a range rather than one exact promised minute;
- includes a separate whole-party start range for groups;
- can narrow the guest's own range from a privacy-safe member start offset;
- labels a recent offline result as last known;
- removes the range and says “updating” after the snapshot expires;
- treats only completed/cancelled terminal states as safe after expiry;
- produces bilingual privacy-safe copy;
- creates a deterministic SHA-256 telemetry fingerprint without PII;
- measures early/within-range/late outcomes without customer or staff data.

## Local evidence

- Focused deterministic, stale, offline, group, privacy and accuracy tests:
  18/18 PASS.
- Generated-range invariants: non-negative, ordered, non-exact and five-minute
  aligned.
- Static pure/provider-free boundary: covered by Vitest.
- TypeScript: PASS.
- Full unit: 672 files passed, 1 skipped; 4,106 tests passed, 1 skipped and
  7 todo.
- Lint: 0 errors; 42 pre-existing warnings outside M4J.
- Next.js production build: PASS; existing Edge Runtime warnings remain.

## Not integrated or proven

- The current public wait page still uses its existing estimate; M4J has not
  changed customer-visible behavior.
- No server loader, realtime event or database record uses the M4J contract yet.
- No QA, Preview, Production, live-salon or pilot evidence exists.

Next safe milestone is M4K: integrate the pure projection behind the TurnIQ
feature flag into a token-safe customer status loader and UI, while retaining
the existing page as the OFF fallback and adding synthetic browser tests.

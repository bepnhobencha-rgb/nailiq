# TurnIQ M4M — Customer check-in server boundary

Status: implemented and tested locally only. Not applied to QA or Production.

## Outcome

- Adds short-lived QR/kiosk capabilities whose raw bearer is never stored.
- Adds an append-only, PII-free shadow intake ledger with exact-once command replay.
- Revalidates the salon flag, tenant, service, booking, party size, and requested staff in the database.
- Adds same-origin, bounded-body, durable IP and capability rate limits.
- Returns only `shadow_received`, a safe next route, a fingerprint, and customer-safe copy.

## Deliberate non-effects

M4M cannot create or modify a booking, assign a technician, consume a turn,
occupy a resource, call a payment or messaging provider, or send a notification.
The M4L pure browser scenarios remain local-only. M4N adds a separate
capability scenario that exercises the endpoint contract with a local
interceptor; no database or provider is called by that browser story.

## Security and rollback

Both tables use enabled and forced RLS. Browser roles receive no table or RPC
grant; only the server service role can issue or record a capability. Capability
use is serialized with a row lock and each command ID is idempotent. Keep the
feature flag OFF and stop issuing capabilities to roll back runtime exposure;
preserve receipt rows as audit evidence.

## Next safe milestone

Completed locally in `docs/TURNIQ_M4N_AUTHENTICATED_CHECKIN_ISSUANCE.md`.

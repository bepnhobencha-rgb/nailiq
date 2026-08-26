# Intentional anonymous `SECURITY DEFINER` boundaries

Audited against production on 2026-07-24.

The Phase-A release contains ten anonymous-executable `SECURITY DEFINER`
signatures (nine function names; `create_public_booking` has old/new rollout
overloads). They are not unreviewed exceptions: they are
the complete allowlist of public booking RPCs that must cross RLS without
granting anonymous users direct access to customer, booking, OTP, or salon
control-plane tables.

Every entry is required to satisfy the executable proof in
`scripts/security/check-intentional-anon-security-definers.sql`:

- owned by `postgres`;
- pinned `search_path`;
- `PUBLIC` and `authenticated` cannot execute it;
- only `anon` and `service_role` can execute it;
- its result contract and security-critical input guards remain present; and
- the protected underlying tables remain inaccessible directly or protected by
  RLS.

| Function | Why definer is intentional | Public result/write boundary |
| --- | --- | --- |
| `add_booking_addons` | Adds catalog-validated add-ons to a booking created in the preceding 15 minutes. | Maximum eight add-ons; same-salon active add-ons only. |
| `check_group_slots_available` | Reads protected booking occupancy for the public group scheduler. | Returns availability and caller-supplied member indexes, never booking/customer fields. |
| `create_public_booking` (legacy + fingerprinted overloads) | Public booking must insert through business-rule and rate-limit enforcement because direct anonymous booking inserts are revoked. The legacy signature remains only for the Phase-A asset overlap. | Both overloads derive money server-side and enforce salon/phone limits; the new overload also requires payload-bound idempotency and an accepted pricing fingerprint. |
| `create_public_waitlist_entry` | Public waitlist submission needs a controlled insert while direct table access remains RLS-blocked. | Allowlisted source plus same-salon service/staff validation. |
| `finalize_public_booking_profile` | A newly committed booking must atomically persist OTP trust and explicit marketing consent without reopening direct profile writes. | Recent booking capability; durable profile link; exact OTP salon, phone, expiry, and single-use state. |
| `get_booking_client_snapshot` | A just-created booking may request a small returning-client snapshot without exposing client profiles. | Booking ID, salon, canonical phone, and ten-minute freshness must all match. |
| `public_booking_occupancy_for_range` | Public scheduling needs occupied intervals but must not read booking/customer records. | Returns only staff ID and start/end timestamps. |
| `public_resolve_domain` | Middleware maps a hostname to a slug; invoker mode would fail because anonymous direct `salons` reads are revoked. | Returns one slug for an exact normalized host. |
| `validate_phone_otp_session` | Booking flows must validate an OTP session without exposing OTP rows. | Boolean only; session, salon, phone, expiry, and consumption state must match. |

`insert_group_bookings(jsonb)` is deliberately absent. Public Group/Party
traffic now crosses the metered application boundary and the service-only
`quote_group_booking` / `create_group_bookings` contract. The legacy writer is
retained for scoped service-role compatibility only.

## Decision

Do not convert these functions to `SECURITY INVOKER` merely to reduce the
Advisor warning count. Doing so would either break public booking/custom-domain
flows or require broader table grants that expose more data than the narrow RPC
contract. Any future addition, removal, grant change, return-shape change, or
guard removal fails CI until this allowlist and its review evidence are updated.

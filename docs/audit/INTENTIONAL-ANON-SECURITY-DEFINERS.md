# Intentional anonymous `SECURITY DEFINER` boundaries

Audited against production on 2026-07-24.

Supabase Security Advisor reports nine anonymous-executable
`SECURITY DEFINER` functions. They are not nine unreviewed exceptions: they are
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
| `create_public_booking` | Public booking must insert through business-rule and rate-limit enforcement because direct anonymous booking inserts are revoked. | Salon and phone rate limits; delegates to the validated booking implementation. |
| `create_public_waitlist_entry` | Public waitlist submission needs a controlled insert while direct table access remains RLS-blocked. | Allowlisted source plus same-salon service/staff validation. |
| `get_booking_client_snapshot` | A just-created booking may request a small returning-client snapshot without exposing client profiles. | Booking ID, salon, canonical phone, and ten-minute freshness must all match. |
| `insert_group_bookings` | A public group booking is an atomic controlled write across protected booking rows. | Group size, salon, service, staff, time, price, and rate limits are validated. |
| `public_booking_occupancy_for_range` | Public scheduling needs occupied intervals but must not read booking/customer records. | Returns only staff ID and start/end timestamps. |
| `public_resolve_domain` | Middleware maps a hostname to a slug; invoker mode would fail because anonymous direct `salons` reads are revoked. | Returns one slug for an exact normalized host. |
| `validate_phone_otp_session` | Booking flows must validate an OTP session without exposing OTP rows. | Boolean only; session, salon, phone, expiry, and consumption state must match. |

## Decision

Do not convert these functions to `SECURITY INVOKER` merely to reduce the
Advisor warning count. Doing so would either break public booking/custom-domain
flows or require broader table grants that expose more data than the narrow RPC
contract. Any future addition, removal, grant change, return-shape change, or
guard removal fails CI until this allowlist and its review evidence are updated.

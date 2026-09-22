# Intentional anonymous `SECURITY DEFINER` boundaries

Updated for the 2026-09-15 trial-capability candidate. Executable proof must
run against the candidate database before this becomes release evidence; this
document does not claim a Production deployment.

The release contract contains thirteen anonymous-executable `SECURITY DEFINER`
signatures in the exposed `public` schema (eleven function names;
`create_public_booking` has legacy/priced/SMS-aware rollout overloads), plus one
resource projection helper in the non-exposed `private` schema. They are not
unreviewed exceptions: together they are the complete allowlist of public
booking boundaries that must cross RLS without
granting anonymous users direct access to customer, booking, OTP, or salon
control-plane tables.

Every entry is required to satisfy the executable proof in
`scripts/security/check-intentional-anon-security-definers.sql`:

- owned by `postgres`;
- pinned `search_path`;
- `PUBLIC` cannot execute it; public-schema mutation/identity RPCs also deny
  `authenticated` unless their exact contract says otherwise;
- only the explicitly documented roles can execute each boundary;
- its result contract and security-critical input guards remain present; and
- the protected underlying tables remain inaccessible directly or protected by
  RLS.

| Function | Why definer is intentional | Public result/write boundary |
| --- | --- | --- |
| `add_booking_addons` | Adds catalog-validated add-ons to a booking created in the preceding 15 minutes. | Maximum eight add-ons; same-salon active add-ons only. |
| `check_group_slots_available` | Reads protected booking occupancy for the public group scheduler. | Returns availability and caller-supplied member indexes, never booking/customer fields. |
| `create_public_booking` (legacy + fingerprinted + SMS-aware overloads) | Public booking must insert through business-rule and rate-limit enforcement because direct anonymous booking inserts are revoked. The legacy signature remains only for the Phase-A asset overlap. | The implementations derive money server-side and enforce salon/phone limits; the SMS-aware overload requires payload-bound idempotency, an accepted pricing fingerprint, and exact unconsumed SMS ownership for phone-bound incentives. The previous priced arity forwards NULL proof and retains safe no-discount/replay compatibility. |
| `finalize_public_booking_profile` | A newly committed booking must atomically finalize its verification without reopening direct profile writes. | Recent booking capability; durable profile link; exact OTP salon, phone, expiry, and single-use state. Global phone-verification and marketing-consent writes require SMS proof; other allowed channels can finalize the booking only. |
| `get_booking_client_snapshot` | A just-created booking with verified phone ownership may request a small returning-client snapshot without exposing client profiles directly. | Booking ID, salon, canonical phone, and ten-minute freshness must match. SMS proof must be linked to and consumed by this exact booking, with finite timestamps showing consumption after verification and before expiry. Email, staff, demo, and legacy proof return no CRM snapshot. The service-only two-argument overload is unchanged. |
| `private.public_booking_resources_for_salon` | The public snapshot needs active bed/chair identity without granting clients direct access to private `salon_resources` columns. It replaces the previous definer-view boundary with an invoker view plus one narrow helper outside exposed Data API schemas. | Returns only `id`, `name`, `kind`, and `display_order` for one published, resource-enabled salon. Only the stateless `anon` booking client and `service_role` may execute it; `PUBLIC` and `authenticated` stay denied and direct table reads remain RLS-blocked. |
| `public_booking_capacity_for_range` | Resource-aware public scheduling needs staff and physical-resource conflicts but must not read booking, segment, or customer records. | Returns only staff/resource IDs and occupied start/end timestamps for the requested salon and range; terminal states are excluded. |
| `public_booking_occupancy_for_range` | Public scheduling needs occupied intervals but must not read booking/customer records. | Returns only staff ID and start/end timestamps. |
| `public_resolve_domain` | Middleware maps a hostname to a slug; invoker mode would fail because anonymous direct `salons` reads are revoked. | Returns one slug for an exact normalized host. |
| `public_salon_accepts_new_bookings` | Public booking must fail closed when an enrolled tenant's trial no longer permits new appointments, while direct anonymous salon reads stay revoked. | Boolean only; combines profile readiness with the server-owned entitlement state and exposes no trial date, billing state, or tenant metadata. |
| `validate_booking_otp_session` | New-booking flows must validate a contact-verification capability without exposing OTP rows or claiming ownership of existing phone-linked data. | Boolean only; exact session/salon/phone, unexpired and unconsumed, with `sms`, `email`, `staff_attested`, or `demo` assurance. `legacy_unverified` is rejected. Does not authorize profile, saved-card, history, or existing-booking access. |
| `validate_phone_otp_session` | Existing phone-linked customer data and actions require proof of phone ownership without exposing OTP rows. | Boolean only; exact session/salon/phone, unexpired and unconsumed, with `sms` assurance only. Email, staff attestation, demo, and legacy sessions cannot pass this gate. |

The new booking validator has the same explicit execution roles as the phone
validator: `anon` and `service_role`; `PUBLIC` and `authenticated` remain denied.
No underlying OTP/profile table grant is added. Existing sessions default to
`legacy_unverified`, so they cannot silently inherit stronger identity proof.
The historical RPC ACL rollback rehearsal retains its original function list;
the new function had no pre-migration ACL to restore.

The proof pins one exact search path for each signature, confirmed against the
canonical migrations and the disposable candidate catalog. Empty paths are
required for all three `create_public_booking` overloads (pricing migration
`20260820083748`), `public_booking_capacity_for_range` (resource migration
`20260901194059`), and the four R07 functions: the two OTP validators,
`finalize_public_booking_profile`, and the three-argument snapshot.
`add_booking_addons` requires `public, pg_catalog`; the group slot probe,
occupancy projection, and domain resolver require `public`. No wildcard path
or unnamed empty-path exception is accepted. The boolean trial-capability RPC
also uses an empty path and schema-qualifies its dependencies.

`insert_group_bookings(jsonb)` is deliberately absent. Public Group/Party
traffic now crosses the metered application boundary and the service-only
`quote_group_booking` / `create_group_bookings` contract. The legacy writer is
retained for scoped service-role compatibility only.

`create_public_capacity_rescue_request` and
`create_public_waitlist_entry` are also deliberately absent. Public web
capacity-rescue submissions now cross a same-origin, rate-limited application
route that revalidates current booking availability before its service-role
write. The legacy waitlist RPC remains service-role-only for the connected
Voice AI path. Anonymous direct table access remains closed.

## Decision

Do not convert these functions to `SECURITY INVOKER` merely to reduce the
Advisor warning count. Doing so would either break public booking/custom-domain
flows or require broader table grants that expose more data than the narrow RPC
contract. Any future addition, removal, grant change, return-shape change, or
guard removal fails CI until this allowlist and its review evidence are updated.

-- Group booking "seat together" / couple preference.
--
-- Head-spa tenants (Hi-Lite) don't have dedicated couple rooms, but
-- they can place two beds side by side and pull a curtain to create a
-- couple space ("2 thành 1"). Friends/family booking together usually
-- want to be seated near each other too. This flag captures that
-- intent at booking time so reception knows to arrange adjacent beds
-- + curtain, rather than scattering the group across far stations.
--
-- Purely additive: NOT NULL DEFAULT false means every existing row is
-- backfilled to false and the column is unused until the booking flow
-- starts setting it. The atomic group-insert RPC is intentionally NOT
-- touched — the value is written by a best-effort post-insert UPDATE
-- in submitGroupBooking (same pattern as client_profiles upsert), so
-- a failure here never blocks a confirmed booking.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS seat_together boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.bookings.seat_together IS
  'Group/couple wants to be seated adjacently (head-spa curtain couple space). Set by submitGroupBooking; surfaced as a 💕 badge on the receptionist board.';

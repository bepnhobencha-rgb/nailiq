-- Membership alone must not grant mutable schedule access. The existing
-- salon_members NOT NULL / role CHECK admits only canonical role values, so
-- this allowlist matches canEditBooking(normalizeSalonMemberRole(role)) for
-- every stored membership. Unknown/NULL values never grant write authority.
-- Preserve policy names, command/role targets, SELECT, anon policies, grants,
-- service-role paths, and all booking integrity triggers.
ALTER POLICY bookings_insert_authenticated ON public.bookings
  WITH CHECK (
    salon_id IN (
      SELECT salon_members.salon_id
      FROM public.salon_members
      WHERE salon_members.user_id = (SELECT auth.uid())
        AND salon_members.role IN ('owner', 'admin', 'senior', 'receptionist')
    )
  );

ALTER POLICY "owner update own salon bookings" ON public.bookings
  USING (
    salon_id IN (
      SELECT salon_members.salon_id
      FROM public.salon_members
      WHERE salon_members.user_id = (SELECT auth.uid())
        AND salon_members.role IN ('owner', 'admin', 'senior', 'receptionist')
    )
  )
  WITH CHECK (
    salon_id IN (
      SELECT salon_members.salon_id
      FROM public.salon_members
      WHERE salon_members.user_id = (SELECT auth.uid())
        AND salon_members.role IN ('owner', 'admin', 'senior', 'receptionist')
    )
  );

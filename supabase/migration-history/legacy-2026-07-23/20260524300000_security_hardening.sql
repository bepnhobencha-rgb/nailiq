-- Security hardening migration
-- Fixes: RLS policies for 3 tables, search_path on 16 functions,
--        salon-imports bucket listing, bookings INSERT check.

-- ─── 1. RLS POLICIES ────────────────────────────────────────────────────────

-- booking_reminder_tokens
-- Salon members manage tokens for their salon.
-- Customer-facing actions (cancel/confirm) go through SECURITY DEFINER
-- functions and don't need direct table access.
CREATE POLICY "salon_member_manage_reminder_tokens"
  ON public.booking_reminder_tokens FOR ALL
  USING (
    salon_id IN (
      SELECT salon_id FROM public.salon_members WHERE user_id = auth.uid()
    )
  );

-- platform_settings — stores Twilio/Resend API keys.
-- Must be service-role only; deny all direct access by authenticated or anon.
CREATE POLICY "deny_all_platform_settings"
  ON public.platform_settings FOR ALL
  USING (false);

-- queue_entries — salon members get full access.
-- Walk-in queue display for anon is served by get_salon_queue()
-- which is SECURITY DEFINER and bypasses RLS.
CREATE POLICY "salon_member_manage_queue_entries"
  ON public.queue_entries FOR ALL
  USING (
    salon_id IN (
      SELECT salon_id FROM public.salon_members WHERE user_id = auth.uid()
    )
  );

-- Anon read for queue display (receptionist center kiosk mode / public queue board)
CREATE POLICY "anon_read_queue_entries"
  ON public.queue_entries FOR SELECT
  TO anon
  USING (
    salon_id IN (
      SELECT id FROM public.salons WHERE archived_at IS NULL
    )
  );

-- ─── 2. BOOKINGS INSERT — add WITH CHECK ────────────────────────────────────

-- Drop the two unrestricted INSERT policies and replace with checked versions.
DROP POLICY IF EXISTS "public insert bookings" ON public.bookings;
DROP POLICY IF EXISTS "bookings_insert_anon"   ON public.bookings;

-- Anon booking: salon must exist and not be archived.
CREATE POLICY "bookings_insert_anon"
  ON public.bookings FOR INSERT
  TO anon
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.salons
      WHERE id = salon_id
        AND archived_at IS NULL
    )
  );

-- Authenticated (salon member) insert: same check.
-- (bookings_insert_authenticated already existed; this replaces anon gap only.)

-- ─── 3. STORAGE — restrict salon-imports listing ────────────────────────────

-- Drop the broad SELECT that allows listing the entire bucket.
DROP POLICY IF EXISTS "public_read_salon_imports" ON storage.objects;

-- Public buckets already serve individual files via signed CDN URLs without
-- needing a SELECT policy. Only authenticated salon members should be able to
-- list/read objects in their own salon folder via the storage API.
CREATE POLICY "salon_member_read_own_imports"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'salon-imports'
    AND (storage.foldername(name))[1] IN (
      SELECT sm.salon_id::text
      FROM public.salon_members sm
      WHERE sm.user_id = auth.uid()
    )
  );

-- ─── 4. FUNCTION search_path ────────────────────────────────────────────────
-- ALTER FUNCTION ... SET search_path pins the resolution path, preventing
-- a malicious user from shadowing public objects via a mutable search_path.

ALTER FUNCTION public.set_updated_at()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.touch_booking_patterns_updated_at()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.touch_customer_photo_consents_updated_at()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.touch_customer_preferences_updated_at()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.touch_referrals_updated_at()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.touch_vouchers_updated_at()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.increment_voucher_used_count()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.update_salon_page_sections_updated_at()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.update_website_import_jobs_updated_at()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.staff_services_same_salon_trg()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.compute_no_show_risk(integer, integer, integer)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.seed_default_page_sections(uuid)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.get_salon_queue(uuid)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.add_queue_entry(uuid, text, text, uuid, uuid, text, integer)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.update_queue_entry_status(uuid, text, uuid)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.create_referral_code(uuid, text, integer, integer)
  SET search_path = public, pg_catalog;

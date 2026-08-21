-- MQA-0015 / MQA-0044 / MQA-0046: authoritative multi-service sequence V1.
--
-- This is an additive, default-off contract. It does not enable either the
-- platform gate or any salon gate. Existing Group/Voice/single-main writers
-- remain on schedule_model='single'.

DO $hilite_sequence_rollout_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.platform_flags p
    WHERE p.key = 'feature_multi_service_booking' AND p.enabled IS TRUE
  ) OR EXISTS (
    SELECT 1 FROM public.salons s
    WHERE s.archived_at IS NULL
      AND s.feature_flags->'multi_service_booking_enabled' = 'true'::jsonb
  ) THEN
    RAISE EXCEPTION
      'multi-service rollout blocked: platform and every active salon gate must be OFF before schema/app Phase A lands';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.salons s
    WHERE s.archived_at IS NULL
      AND (
        lower(trim(s.name)) IN ('hi-lite head spa', 'hi-lite studio')
        OR lower(trim(s.slug)) IN ('hilite-anaheim', 'hilite-studio')
      )
      AND s.feature_flags->'multi_service_booking_enabled' = 'true'::jsonb
  ) THEN
    RAISE EXCEPTION
      'multi-service rollout blocked: Hi-Lite production salon has multi_service_booking_enabled=true';
  END IF;
END;
$hilite_sequence_rollout_preflight$;

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS prep_minutes integer NOT NULL DEFAULT 0;

-- A consumed OTP session must remain durably attributable to the booking that
-- consumed it.  Existing legacy sessions remain compatible (NULL means they
-- predate this binding); every new sequence create writes both sides in one
-- transaction.  NOT VALID avoids a historical-table validation scan while
-- still enforcing both constraints for new and changed rows.
ALTER TABLE public.phone_otp_sessions
  ADD COLUMN IF NOT EXISTS consumed_by_booking_id uuid;
ALTER TABLE public.phone_otp_sessions
  DROP CONSTRAINT IF EXISTS phone_otp_sessions_consumed_binding_check;
ALTER TABLE public.phone_otp_sessions
  ADD CONSTRAINT phone_otp_sessions_consumed_binding_check
  CHECK (consumed_by_booking_id IS NULL OR consumed_at IS NOT NULL) NOT VALID;
ALTER TABLE public.phone_otp_sessions
  DROP CONSTRAINT IF EXISTS phone_otp_sessions_consumed_booking_id_fkey;
ALTER TABLE public.phone_otp_sessions
  ADD CONSTRAINT phone_otp_sessions_consumed_booking_id_fkey
  FOREIGN KEY (consumed_by_booking_id) REFERENCES public.bookings(id)
  ON DELETE SET NULL NOT VALID;

COMMENT ON COLUMN public.phone_otp_sessions.consumed_by_booking_id IS
  'Durable response-loss/replay binding for an OTP session atomically consumed by an authoritative booking writer; NULL is retained for legacy consumers.';

ALTER TABLE public.services
  DROP CONSTRAINT IF EXISTS services_prep_minutes_check;
ALTER TABLE public.services
  ADD CONSTRAINT services_prep_minutes_check
  CHECK (prep_minutes BETWEEN 0 AND 180) NOT VALID;
ALTER TABLE public.services
  VALIDATE CONSTRAINT services_prep_minutes_check;

COMMENT ON COLUMN public.services.prep_minutes IS
  'Operational capacity required immediately before customer work. Multi-service sequence V1 only; default 0 preserves every existing schedule.';

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS multi_service_booking_qa_salon_id uuid
    REFERENCES public.salons(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.platform_settings.multi_service_booking_qa_salon_id IS
  'Single disposable Salon QA allowlist for the default-off multi-service Phase A. NULL blocks every salon even if flags are accidentally enabled.';

CREATE OR REPLACE FUNCTION public.protect_multi_service_booking_rollout_flag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $protect_multi_service_flag$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_uid uuid := (SELECT auth.uid());
  v_old jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL
    ELSE OLD.feature_flags->'multi_service_booking_enabled' END;
  v_new jsonb := NEW.feature_flags->'multi_service_booking_enabled';
  v_allowlisted uuid;
BEGIN
  IF v_old IS NOT DISTINCT FROM v_new THEN RETURN NEW; END IF;
  IF v_new IS NOT NULL AND pg_catalog.jsonb_typeof(v_new) <> 'boolean' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'multi-service flag must be JSON boolean';
  END IF;
  IF TG_OP = 'INSERT' AND coalesce(v_new, 'false'::jsonb) <> 'true'::jsonb THEN
    RETURN NEW;
  END IF;
  IF NOT (
    v_role = 'service_role'
    OR (v_role = '' AND session_user IN ('postgres', 'supabase_admin'))
    OR (v_role = 'authenticated' AND v_uid IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.superadmins sa WHERE sa.user_id = v_uid AND sa.revoked_at IS NULL
    ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'multi-service rollout flag requires SuperAdmin authorization';
  END IF;
  IF v_new = 'true'::jsonb THEN
    SELECT ps.multi_service_booking_qa_salon_id INTO v_allowlisted
    FROM public.platform_settings ps WHERE ps.id = 'platform';
    IF v_allowlisted IS DISTINCT FROM NEW.id
       OR NEW.archived_at IS NOT NULL
       OR NEW.is_beta IS NOT TRUE
       OR lower(trim(NEW.name)) IN ('hi-lite head spa', 'hi-lite studio')
       OR lower(trim(NEW.slug)) IN ('hilite-anaheim', 'hilite-studio') THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'multi-service Phase A may be enabled only for the configured disposable Salon QA';
    END IF;
  END IF;
  RETURN NEW;
END;
$protect_multi_service_flag$;

REVOKE ALL ON FUNCTION public.protect_multi_service_booking_rollout_flag()
  FROM PUBLIC, anon, authenticated;
CREATE TRIGGER protect_multi_service_booking_rollout_flag_trigger
  BEFORE INSERT OR UPDATE OF feature_flags ON public.salons
  FOR EACH ROW EXECUTE FUNCTION public.protect_multi_service_booking_rollout_flag();

CREATE OR REPLACE FUNCTION public.configure_multi_service_booking_qa_salon(
  p_salon_id uuid,
  p_enable boolean,
  p_confirmation text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $configure_sequence_qa_salon$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_platform_enabled boolean := false;
  v_salon public.salons%ROWTYPE;
  v_allowlisted uuid;
  v_readiness jsonb;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_enable IS NULL
     OR p_confirmation IS DISTINCT FROM (CASE WHEN p_enable
       THEN 'ENABLE_MULTI_SERVICE_QA' ELSE 'DISABLE_MULTI_SERVICE_QA' END) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'confirmation_required');
  END IF;

  -- Keep the same canonical lock order as sequence create: platform feature,
  -- platform singleton, then salon. This setter never exposes a half-written
  -- allowlist/tenant-gate state outside its transaction.
  PERFORM p.key FROM public.platform_flags p
  WHERE p.key = 'feature_multi_service_booking' FOR UPDATE;
  SELECT coalesce(p.enabled, false) INTO v_platform_enabled
  FROM public.platform_flags p WHERE p.key = 'feature_multi_service_booking';

  INSERT INTO public.platform_settings(id) VALUES ('platform')
  ON CONFLICT (id) DO NOTHING;
  SELECT ps.multi_service_booking_qa_salon_id INTO v_allowlisted
  FROM public.platform_settings ps WHERE ps.id = 'platform' FOR UPDATE;

  SELECT s.* INTO v_salon FROM public.salons s
  WHERE s.id = p_salon_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'not_found');
  END IF;

  IF p_enable THEN
    IF NOT coalesce(v_platform_enabled, false) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'platform_disabled');
    END IF;
    IF v_allowlisted IS NOT NULL AND v_allowlisted IS DISTINCT FROM p_salon_id THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'allowlist_conflict');
    END IF;
    IF v_salon.archived_at IS NOT NULL
       OR v_salon.subscription_status NOT IN ('active', 'trialing')
       OR v_salon.is_beta IS NOT TRUE
       OR lower(trim(v_salon.name)) IN ('hi-lite head spa', 'hi-lite studio')
       OR lower(trim(v_salon.slug)) IN ('hilite-anaheim', 'hilite-studio') THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'salon_not_disposable_qa');
    END IF;

    BEGIN
      UPDATE public.platform_settings ps
      SET multi_service_booking_qa_salon_id = p_salon_id,
          updated_at = pg_catalog.transaction_timestamp()
      WHERE ps.id = 'platform';
      UPDATE public.salons s
      SET feature_flags = pg_catalog.jsonb_set(
        coalesce(s.feature_flags, '{}'::jsonb),
        '{multi_service_booking_enabled}', 'true'::jsonb, true
      )
      WHERE s.id = p_salon_id;

      v_readiness := public.load_public_booking_sequence_readiness(p_salon_id);
      IF coalesce((v_readiness->>'ready')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'NQ001',
          MESSAGE = 'multi-service QA salon is not readiness-complete';
      END IF;
    EXCEPTION WHEN SQLSTATE 'NQ001' THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false, 'code', 'not_ready', 'salon_id', p_salon_id,
        'readiness', coalesce(v_readiness, '{}'::jsonb)
      );
    END;
    RETURN pg_catalog.jsonb_build_object(
      'success', true, 'code', 'enabled', 'salon_id', p_salon_id,
      'readiness', v_readiness
    );
  END IF;

  IF v_allowlisted IS NOT NULL AND v_allowlisted IS DISTINCT FROM p_salon_id THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'allowlist_conflict');
  END IF;
  UPDATE public.salons s
  SET feature_flags = coalesce(s.feature_flags, '{}'::jsonb)
    - 'multi_service_booking_enabled'
  WHERE s.id = p_salon_id;
  UPDATE public.platform_settings ps
  SET multi_service_booking_qa_salon_id = NULL,
      updated_at = pg_catalog.transaction_timestamp()
  WHERE ps.id = 'platform' AND ps.multi_service_booking_qa_salon_id = p_salon_id;
  RETURN pg_catalog.jsonb_build_object(
    'success', true, 'code', 'disabled', 'salon_id', p_salon_id
  );
END;
$configure_sequence_qa_salon$;

REVOKE ALL ON FUNCTION public.configure_multi_service_booking_qa_salon(uuid, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_multi_service_booking_qa_salon(uuid, boolean, text)
  TO service_role;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS schedule_model text NOT NULL DEFAULT 'single',
  ADD COLUMN IF NOT EXISTS sequence_version smallint;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_schedule_model_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_schedule_model_check
  CHECK (schedule_model IN ('single', 'segments_v1')) NOT VALID;
ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_sequence_version_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_sequence_version_check
  CHECK (
    (schedule_model = 'single' AND sequence_version IS NULL)
    OR (schedule_model = 'segments_v1' AND sequence_version = 1)
  ) NOT VALID;
ALTER TABLE public.bookings
  VALIDATE CONSTRAINT bookings_schedule_model_check,
  VALIDATE CONSTRAINT bookings_sequence_version_check;

COMMENT ON COLUMN public.bookings.schedule_model IS
  'single preserves legacy parent-row scheduling; segments_v1 delegates capacity to booking_service_segments.';
COMMENT ON COLUMN public.bookings.sequence_version IS
  'Version of the immutable ordered-sequence contract. NULL for legacy/single bookings.';

CREATE TABLE public.booking_service_segments (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  position smallint NOT NULL,
  line_id uuid NOT NULL,
  service_id uuid NOT NULL REFERENCES public.services(id),
  staff_id uuid NOT NULL REFERENCES public.staff(id),
  resource_id uuid REFERENCES public.salon_resources(id),
  customer_start_utc timestamptz NOT NULL,
  customer_end_utc timestamptz NOT NULL,
  occupied_start_utc timestamptz NOT NULL,
  occupied_end_utc timestamptz NOT NULL,
  prep_minutes integer NOT NULL,
  service_duration_minutes integer NOT NULL,
  sequential_addon_minutes integer NOT NULL DEFAULT 0,
  trailing_buffer_minutes integer NOT NULL DEFAULT 0,
  service_name text NOT NULL,
  staff_name text NOT NULL,
  original_service_price_cents integer NOT NULL,
  service_pre_voucher_cents integer NOT NULL,
  addon_pre_voucher_cents integer NOT NULL DEFAULT 0,
  promo_discount_cents integer NOT NULL DEFAULT 0,
  email_discount_cents integer NOT NULL DEFAULT 0,
  voucher_discount_cents integer NOT NULL DEFAULT 0,
  service_price_cents integer NOT NULL,
  addon_price_cents integer NOT NULL DEFAULT 0,
  subtotal_cents integer NOT NULL,
  tax_cents integer NOT NULL DEFAULT 0,
  total_cents integer NOT NULL,
  promo_id uuid REFERENCES public.promotions(id),
  addon_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  tax_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  reservation_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT booking_service_segments_position_check CHECK (position BETWEEN 0 AND 4),
  CONSTRAINT booking_service_segments_time_order_check CHECK (
    occupied_start_utc <= customer_start_utc
    AND customer_start_utc < customer_end_utc
    AND customer_end_utc <= occupied_end_utc
  ),
  CONSTRAINT booking_service_segments_duration_check CHECK (
    prep_minutes BETWEEN 0 AND 180
    AND service_duration_minutes BETWEEN 1 AND 1440
    AND sequential_addon_minutes BETWEEN 0 AND 1440
    AND trailing_buffer_minutes BETWEEN 0 AND 720
    AND customer_end_utc = customer_start_utc
      + pg_catalog.make_interval(mins => service_duration_minutes + sequential_addon_minutes)
    AND occupied_start_utc = customer_start_utc
      - pg_catalog.make_interval(mins => prep_minutes)
    AND occupied_end_utc = customer_end_utc
      + pg_catalog.make_interval(mins => trailing_buffer_minutes)
  ),
  CONSTRAINT booking_service_segments_money_check CHECK (
    original_service_price_cents >= 0
    AND service_pre_voucher_cents >= 0
    AND addon_pre_voucher_cents >= 0
    AND promo_discount_cents >= 0
    AND email_discount_cents >= 0
    AND voucher_discount_cents >= 0
    AND service_price_cents >= 0
    AND addon_price_cents >= 0
    AND subtotal_cents = service_price_cents + addon_price_cents
    AND tax_cents >= 0
    AND total_cents = subtotal_cents + tax_cents
    AND service_pre_voucher_cents + promo_discount_cents = original_service_price_cents
    AND email_discount_cents + voucher_discount_cents
      <= service_pre_voucher_cents + addon_pre_voucher_cents
  ),
  CONSTRAINT booking_service_segments_json_check CHECK (
    pg_catalog.jsonb_typeof(addon_lines) = 'array'
    AND pg_catalog.jsonb_typeof(tax_breakdown) = 'array'
  ),
  CONSTRAINT booking_service_segments_status_check CHECK (
    reservation_status IN (
      'pending', 'confirmed', 'completed', 'cancelled',
      'waiting', 'in_progress', 'no_show'
    )
  ),
  UNIQUE (booking_id, position),
  UNIQUE (booking_id, line_id)
);

COMMENT ON TABLE public.booking_service_segments IS
  'Authoritative ordered capacity and money snapshots for schedule_model=segments_v1. Direct public access is denied; service RPCs own writes.';

ALTER TABLE public.booking_addons
  ADD COLUMN IF NOT EXISTS booking_service_segment_id uuid
    REFERENCES public.booking_service_segments(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.protect_sequence_booking_addon_material()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $protect_sequence_addon$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
BEGIN
  IF TG_OP = 'INSERT' AND NEW.booking_service_segment_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.booking_service_segments seg
      WHERE seg.id = NEW.booking_service_segment_id
        AND seg.booking_id = NEW.booking_id
        AND EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_array_elements(seg.addon_lines) a(value)
          WHERE (a.value->>'service_id')::uuid = NEW.service_id
        )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'sequence addon material mismatch';
    END IF;
  ELSIF TG_OP = 'UPDATE'
        AND OLD.booking_service_segment_id IS NOT NULL
        AND v_role IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'sequence addon material is immutable';
  ELSIF TG_OP = 'DELETE'
        AND OLD.booking_service_segment_id IS NOT NULL
        AND v_role IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'sequence addon material is immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$protect_sequence_addon$;

REVOKE ALL ON FUNCTION public.protect_sequence_booking_addon_material()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER protect_sequence_booking_addon_material
  BEFORE INSERT OR UPDATE OR DELETE ON public.booking_addons
  FOR EACH ROW EXECUTE FUNCTION public.protect_sequence_booking_addon_material();

CREATE INDEX booking_service_segments_booking_order_idx
  ON public.booking_service_segments (booking_id, position);
CREATE INDEX booking_service_segments_salon_start_idx
  ON public.booking_service_segments (salon_id, customer_start_utc);
CREATE INDEX booking_addons_segment_idx
  ON public.booking_addons (booking_service_segment_id)
  WHERE booking_service_segment_id IS NOT NULL;

ALTER TABLE public.booking_service_segments
  ADD CONSTRAINT booking_service_segments_staff_no_overlap
  EXCLUDE USING gist (
    salon_id WITH =,
    staff_id WITH =,
    pg_catalog.tstzrange(occupied_start_utc, occupied_end_utc, '[)') WITH &&
  ) WHERE (reservation_status NOT IN ('cancelled', 'no_show', 'completed'));

ALTER TABLE public.booking_service_segments
  ADD CONSTRAINT booking_service_segments_resource_no_overlap
  EXCLUDE USING gist (
    salon_id WITH =,
    resource_id WITH =,
    pg_catalog.tstzrange(occupied_start_utc, occupied_end_utc, '[)') WITH &&
  ) WHERE (
    resource_id IS NOT NULL
    AND reservation_status NOT IN ('cancelled', 'no_show', 'completed')
  );

-- Cross-table checks are required because exclusion constraints cannot span
-- bookings and booking_service_segments. Both directions take the same
-- transaction-scoped advisory keys before checking the opposite table, so a
-- concurrent single writer and sequence writer cannot both observe empty.
CREATE OR REPLACE FUNCTION public.enforce_booking_capacity_across_models()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $capacity_models$
DECLARE
  v_is_live boolean;
  v_salon_id uuid;
  v_staff_id uuid;
  v_resource_id uuid;
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'bookings' THEN
    IF NEW.schedule_model <> 'single' THEN
      RETURN NEW;
    END IF;
    v_is_live := NEW.status NOT IN ('cancelled', 'no_show', 'completed');
    v_salon_id := NEW.salon_id;
    v_staff_id := NEW.staff_id;
    v_resource_id := NEW.resource_id;
    v_start := NEW.start_time_utc;
    v_end := NEW.end_time_utc;
  ELSE
    v_is_live := NEW.reservation_status NOT IN ('cancelled', 'no_show', 'completed');
    v_salon_id := NEW.salon_id;
    v_staff_id := NEW.staff_id;
    v_resource_id := NEW.resource_id;
    v_start := NEW.occupied_start_utc;
    v_end := NEW.occupied_end_utc;
  END IF;

  IF NOT v_is_live OR v_start IS NULL OR v_end IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_staff_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'booking-capacity:staff:' || v_salon_id::text || ':' || v_staff_id::text,
        0
      )
    );
  END IF;
  IF v_resource_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'booking-capacity:resource:' || v_salon_id::text || ':' || v_resource_id::text,
        0
      )
    );
  END IF;

  IF TG_TABLE_NAME = 'bookings' THEN
    IF EXISTS (
      SELECT 1
      FROM public.booking_service_segments seg
      WHERE seg.salon_id = v_salon_id
        AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
        AND (
          seg.staff_id = v_staff_id
          OR (v_resource_id IS NOT NULL AND seg.resource_id = v_resource_id)
        )
        AND pg_catalog.tstzrange(seg.occupied_start_utc, seg.occupied_end_utc, '[)')
          && pg_catalog.tstzrange(v_start, v_end, '[)')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'cross-model capacity conflict';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM public.bookings b
      WHERE b.salon_id = v_salon_id
        AND b.schedule_model = 'single'
        AND b.status NOT IN ('cancelled', 'no_show', 'completed')
        AND (
          b.staff_id = v_staff_id
          OR (v_resource_id IS NOT NULL AND b.resource_id = v_resource_id)
        )
        AND pg_catalog.tstzrange(b.start_time_utc, b.end_time_utc, '[)')
          && pg_catalog.tstzrange(v_start, v_end, '[)')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'cross-model capacity conflict';
    END IF;
  END IF;
  RETURN NEW;
END;
$capacity_models$;

REVOKE ALL ON FUNCTION public.enforce_booking_capacity_across_models()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER enforce_single_booking_capacity_across_models
  BEFORE INSERT OR UPDATE OF salon_id, staff_id, resource_id,
    start_time_utc, end_time_utc, status, schedule_model
  ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_booking_capacity_across_models();

CREATE TRIGGER enforce_segment_capacity_across_models
  BEFORE INSERT OR UPDATE OF salon_id, staff_id, resource_id,
    occupied_start_utc, occupied_end_utc, reservation_status
  ON public.booking_service_segments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_booking_capacity_across_models();

CREATE OR REPLACE FUNCTION public.enforce_booking_service_segment_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $segment_parent$
DECLARE
  v_parent public.bookings%ROWTYPE;
  v_service_salon uuid;
  v_staff_salon uuid;
  v_resource_salon uuid;
BEGIN
  SELECT b.* INTO v_parent
  FROM public.bookings b
  WHERE b.id = NEW.booking_id
  FOR KEY SHARE;
  IF NOT FOUND
     OR v_parent.salon_id <> NEW.salon_id
     OR v_parent.schedule_model <> 'segments_v1'
     OR v_parent.sequence_version <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid sequence parent';
  END IF;

  SELECT s.salon_id INTO v_service_salon
  FROM public.services s
  WHERE s.id = NEW.service_id AND s.deleted_at IS NULL AND s.is_addon IS FALSE;
  SELECT st.salon_id INTO v_staff_salon
  FROM public.staff st
  WHERE st.id = NEW.staff_id AND st.status = 'active' AND st.deleted_at IS NULL;
  IF NEW.resource_id IS NOT NULL THEN
    SELECT r.salon_id INTO v_resource_salon
    FROM public.salon_resources r
    WHERE r.id = NEW.resource_id AND r.status = 'active' AND r.deleted_at IS NULL;
  END IF;
  IF v_service_salon IS DISTINCT FROM NEW.salon_id
     OR v_staff_salon IS DISTINCT FROM NEW.salon_id
     OR (NEW.resource_id IS NOT NULL AND v_resource_salon IS DISTINCT FROM NEW.salon_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'sequence tenant/reference mismatch';
  END IF;

  IF NOT (
    TG_OP = 'UPDATE'
    AND current_setting('nailiq.sequence_reschedule_booking_id', true)
      = NEW.booking_id::text
  ) THEN
    NEW.reservation_status := CASE
      WHEN v_parent.deleted_at IS NOT NULL THEN 'cancelled'
      ELSE v_parent.status
    END;
  END IF;
  RETURN NEW;
END;
$segment_parent$;

REVOKE ALL ON FUNCTION public.enforce_booking_service_segment_parent()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER enforce_booking_service_segment_parent
  BEFORE INSERT OR UPDATE ON public.booking_service_segments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_booking_service_segment_parent();

CREATE TRIGGER set_booking_service_segments_updated_at
  BEFORE UPDATE ON public.booking_service_segments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.protect_booking_service_segment_material()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $protect_segment_material$
BEGIN
  IF current_setting('nailiq.sequence_reschedule_booking_id', true)
       = OLD.booking_id::text
     AND NEW.booking_id = OLD.booking_id
     AND NEW.salon_id = OLD.salon_id
     AND NEW.position = OLD.position
     AND NEW.line_id = OLD.line_id
     AND NEW.service_id = OLD.service_id
     AND NEW.original_service_price_cents = OLD.original_service_price_cents
     AND NEW.service_pre_voucher_cents = OLD.service_pre_voucher_cents
     AND NEW.addon_pre_voucher_cents = OLD.addon_pre_voucher_cents
     AND NEW.promo_discount_cents = OLD.promo_discount_cents
     AND NEW.email_discount_cents = OLD.email_discount_cents
     AND NEW.voucher_discount_cents = OLD.voucher_discount_cents
     AND NEW.service_price_cents = OLD.service_price_cents
     AND NEW.addon_price_cents = OLD.addon_price_cents
     AND NEW.subtotal_cents = OLD.subtotal_cents
     AND NEW.tax_cents = OLD.tax_cents
     AND NEW.total_cents = OLD.total_cents
     AND NEW.promo_id IS NOT DISTINCT FROM OLD.promo_id
     AND NEW.addon_lines IS NOT DISTINCT FROM OLD.addon_lines
     AND NEW.tax_breakdown IS NOT DISTINCT FROM OLD.tax_breakdown THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['reservation_status','updated_at']::text[])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['reservation_status','updated_at']::text[]) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'booking service segment schedule/pricing material is immutable';
  END IF;
  RETURN NEW;
END;
$protect_segment_material$;

REVOKE ALL ON FUNCTION public.protect_booking_service_segment_material()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER protect_booking_service_segment_material
  BEFORE UPDATE ON public.booking_service_segments
  FOR EACH ROW EXECUTE FUNCTION public.protect_booking_service_segment_material();

CREATE OR REPLACE FUNCTION public.protect_sequence_parent_schedule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $protect_sequence_parent$
BEGIN
  IF OLD.schedule_model = 'segments_v1'
     AND current_setting('nailiq.sequence_reschedule_booking_id', true) = OLD.id::text
     AND NEW.id = OLD.id AND NEW.salon_id = OLD.salon_id
     AND NEW.schedule_model = OLD.schedule_model
     AND NEW.sequence_version = OLD.sequence_version
     AND NEW.price_cents = OLD.price_cents
     AND NEW.addon_price_cents IS NOT DISTINCT FROM OLD.addon_price_cents
     AND NEW.original_price_cents = OLD.original_price_cents
     AND NEW.subtotal_cents = OLD.subtotal_cents
     AND NEW.tax_amount_cents = OLD.tax_amount_cents
     AND NEW.promo_id IS NOT DISTINCT FROM OLD.promo_id
     AND NEW.public_booking_request_fingerprint
       = OLD.public_booking_request_fingerprint THEN
    RETURN NEW;
  END IF;
  IF OLD.schedule_model = 'segments_v1' AND (
    NEW.schedule_model IS DISTINCT FROM OLD.schedule_model
    OR NEW.sequence_version IS DISTINCT FROM OLD.sequence_version
    OR NEW.start_time_utc IS DISTINCT FROM OLD.start_time_utc
    OR NEW.end_time_utc IS DISTINCT FROM OLD.end_time_utc
    OR NEW.service_id IS DISTINCT FROM OLD.service_id
    OR NEW.staff_id IS DISTINCT FROM OLD.staff_id
    OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
    OR NEW.price_cents IS DISTINCT FROM OLD.price_cents
    OR NEW.addon_price_cents IS DISTINCT FROM OLD.addon_price_cents
    OR NEW.original_price_cents IS DISTINCT FROM OLD.original_price_cents
    OR NEW.subtotal_cents IS DISTINCT FROM OLD.subtotal_cents
    OR NEW.tax_amount_cents IS DISTINCT FROM OLD.tax_amount_cents
    OR NEW.promo_id IS DISTINCT FROM OLD.promo_id
    OR NEW.public_booking_request_fingerprint
       IS DISTINCT FROM OLD.public_booking_request_fingerprint
    OR NEW.public_booking_pricing_fingerprint
       IS DISTINCT FROM OLD.public_booking_pricing_fingerprint
    OR (
      NEW.public_booking_pricing_snapshot
        IS DISTINCT FROM OLD.public_booking_pricing_snapshot
      AND NOT (
        NOT coalesce(OLD.public_booking_pricing_snapshot ? 'booking_id', false)
        AND NOT coalesce(OLD.public_booking_pricing_snapshot ? 'segment_ids', false)
        AND NOT coalesce(OLD.public_booking_pricing_snapshot ? 'reschedule_intent', false)
        AND NEW.public_booking_pricing_snapshot->>'booking_id' = OLD.id::text
        AND pg_catalog.jsonb_typeof(
          NEW.public_booking_pricing_snapshot->'segment_ids'
        ) = 'array'
        AND pg_catalog.jsonb_typeof(
          NEW.public_booking_pricing_snapshot->'reschedule_intent'
        ) = 'object'
        AND (NEW.public_booking_pricing_snapshot
          - ARRAY[
            'booking_id','segment_ids','reschedule_intent',
            'sms_consent','notification_language','salon_slug'
          ]::text[])
          IS NOT DISTINCT FROM OLD.public_booking_pricing_snapshot
      )
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'sequence schedule changes require a canonical full-sequence reschedule contract';
  END IF;
  RETURN NEW;
END;
$protect_sequence_parent$;

REVOKE ALL ON FUNCTION public.protect_sequence_parent_schedule()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER protect_sequence_parent_schedule
  BEFORE UPDATE OF schedule_model, sequence_version, start_time_utc, end_time_utc,
    service_id, staff_id, resource_id, price_cents, addon_price_cents,
    original_price_cents, subtotal_cents, tax_amount_cents, promo_id,
    public_booking_request_fingerprint, public_booking_pricing_fingerprint,
    public_booking_pricing_snapshot
  ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.protect_sequence_parent_schedule();

CREATE OR REPLACE FUNCTION public.sync_booking_service_segment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sync_segment_status$
BEGIN
  IF NEW.schedule_model = 'segments_v1' THEN
    UPDATE public.booking_service_segments seg
    SET reservation_status = CASE
      WHEN NEW.deleted_at IS NOT NULL THEN 'cancelled'
      ELSE NEW.status
    END
    WHERE seg.booking_id = NEW.id
      AND seg.reservation_status IS DISTINCT FROM CASE
        WHEN NEW.deleted_at IS NOT NULL THEN 'cancelled'
        ELSE NEW.status
      END;
  END IF;
  RETURN NEW;
END;
$sync_segment_status$;

REVOKE ALL ON FUNCTION public.sync_booking_service_segment_status()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER sync_booking_service_segment_status
  AFTER UPDATE OF status, deleted_at ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.sync_booking_service_segment_status();

-- Install segment protection first, then narrow the parent constraints in the
-- same migration transaction. There is no externally visible unprotected
-- interval.
ALTER TABLE public.bookings DROP CONSTRAINT bookings_no_overlap;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    salon_id WITH =,
    staff_id WITH =,
    pg_catalog.tstzrange(start_time_utc, end_time_utc, '[)') WITH &&
  ) WHERE (
    schedule_model = 'single'
    AND status NOT IN ('cancelled', 'no_show', 'completed')
  );

ALTER TABLE public.bookings DROP CONSTRAINT bookings_resource_no_overlap;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_resource_no_overlap
  EXCLUDE USING gist (
    salon_id WITH =,
    resource_id WITH =,
    pg_catalog.tstzrange(start_time_utc, end_time_utc, '[)') WITH &&
  ) WHERE (
    schedule_model = 'single'
    AND resource_id IS NOT NULL
    AND status NOT IN ('cancelled', 'no_show', 'completed')
  );

ALTER TABLE public.booking_service_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_service_segments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.booking_service_segments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.booking_service_segments TO service_role;

-- Append prep_minutes to the established narrow public catalog. SECURITY
-- INVOKER and the base-table row policy remain unchanged.
CREATE OR REPLACE VIEW public.public_service_catalog
WITH (security_barrier = true, security_invoker = true) AS
SELECT
  id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
  category, description, is_popular, is_featured, price_type,
  price_max_cents, is_addon, addon_timing, prep_minutes
FROM public.services
WHERE deleted_at IS NULL;

GRANT SELECT (prep_minutes) ON TABLE public.services TO anon;
REVOKE ALL ON TABLE public.public_service_catalog FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_service_catalog TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_booking_sequence_pricing_and_schedule(
  p_request jsonb,
  p_lock_claims boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sequence_resolver$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_salon_id uuid;
  v_request_id uuid;
  v_requested_start timestamptz;
  v_client_phone text;
  v_client_email text;
  v_apply_email boolean;
  v_same_staff boolean;
  v_voucher_id uuid;
  v_lines_input jsonb;
  v_line_input jsonb;
  v_line jsonb;
  v_customer jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_final_lines jsonb := '[]'::jsonb;
  v_ord integer;
  v_position integer;
  v_service_id uuid;
  v_line_id uuid;
  v_staff_preference text;
  v_staff_id uuid;
  v_explicit_staff_id uuid;
  v_common_staff_id uuid;
  v_resource_id uuid;
  v_addon_ids uuid[];
  v_customer_start timestamptz;
  v_customer_end timestamptz;
  v_occupied_start timestamptz;
  v_occupied_end timestamptz;
  v_expected_end timestamptz;
  v_service_duration integer;
  v_prep_minutes integer;
  v_trailing_buffer integer;
  v_sequence_extra integer;
  v_expected_block_extra integer;
  v_search_minutes integer;
  v_quote jsonb;
  v_platform_enabled boolean;
  v_salon_enabled boolean;
  v_qa_allowlisted boolean := false;
  v_salon_archived timestamptz;
  v_currency text;
  v_tax_lines jsonb;
  v_tax_line jsonb;
  v_tax_rate numeric;
  v_tax_enabled boolean;
  v_tax_line_amount integer;
  v_tax_floor_sum integer;
  v_tax_remainder_count integer;
  v_tax_breakdown jsonb := '[]'::jsonb;
  v_original integer := 0;
  v_promo integer := 0;
  v_email integer := 0;
  v_voucher_discount integer := 0;
  v_pre_voucher integer := 0;
  v_eligible_total integer := 0;
  v_remaining integer := 0;
  v_subtotal integer := 0;
  v_tax integer := 0;
  v_total integer := 0;
  v_service_pre integer;
  v_addon_pre integer;
  v_email_alloc integer;
  v_voucher_alloc integer;
  v_line_pre integer;
  v_line_subtotal integer;
  v_final_service integer;
  v_final_addon integer;
  v_profile_id uuid;
  v_email_claimed_at timestamptz;
  v_voucher public.vouchers%ROWTYPE;
  v_voucher_code text;
  v_is_eligible boolean;
  v_free_applied boolean := false;
  v_voucher_allocations jsonb := '{}'::jsonb;
  v_material jsonb;
  v_fingerprint text;
  v_timing_segments jsonb;
  v_catalog_ready boolean := false;
  v_service_name text;
  v_service_category text;
  v_timezone text;
  v_local_occupied_start timestamp;
  v_local_occupied_end timestamp;
  v_shift_day text;
  v_opening_hours jsonb;
  v_day_config jsonb;
  v_resources_enabled boolean;
  v_phone_otp_enabled boolean;
  v_noshow_protection_enabled boolean;
  v_payment_provider text;
  v_schedule_only boolean := false;
  v_exclude_booking_id uuid;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_request IS NULL
     OR pg_catalog.jsonb_typeof(p_request) <> 'object'
     OR (p_request - ARRAY[
       'contract_version', 'salon_id', 'request_id',
       'requested_start_time_utc', 'lines', 'same_staff_for_all',
       'voucher_code', 'customer',
       'apply_email_discount', 'expected_pricing_fingerprint',
       'otp_session_id', 'health_acknowledged',
       'sms_consent', 'notification_language',
       'schedule_only', 'exclude_booking_id'
     ]::text[]) <> '{}'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END IF;

  BEGIN
    IF (p_request->>'contract_version')::integer <> 1 THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unsupported_contract');
    END IF;
    v_salon_id := (p_request->>'salon_id')::uuid;
    v_request_id := nullif(p_request->>'request_id', '')::uuid;
    v_requested_start := (p_request->>'requested_start_time_utc')::timestamptz;
    v_same_staff := coalesce((p_request->>'same_staff_for_all')::boolean, false);
    v_apply_email := coalesce((p_request->>'apply_email_discount')::boolean, false);
    v_schedule_only := coalesce((p_request->>'schedule_only')::boolean, false);
    v_exclude_booking_id := nullif(p_request->>'exclude_booking_id', '')::uuid;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format
    OR datetime_field_overflow THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END;
  v_customer := p_request->'customer';
  v_voucher_code := nullif(upper(trim(coalesce(p_request->>'voucher_code', ''))), '');
  IF pg_catalog.jsonb_typeof(v_customer) IS DISTINCT FROM 'object'
     OR (v_customer - ARRAY['name', 'phone', 'email']::text[]) <> '{}'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END IF;
  v_client_phone := pg_catalog.regexp_replace(coalesce(v_customer->>'phone', ''), '\D', '', 'g');
  v_client_email := nullif(lower(trim(coalesce(v_customer->>'email', ''))), '');
  v_lines_input := p_request->'lines';

  IF v_schedule_only IS DISTINCT FROM (v_exclude_booking_id IS NOT NULL)
     OR (v_schedule_only AND NOT EXISTS (
       SELECT 1 FROM public.bookings existing
       WHERE existing.id=v_exclude_booking_id
         AND existing.salon_id=v_salon_id
         AND existing.schedule_model='segments_v1'
         AND existing.sequence_version=1
         AND existing.deleted_at IS NULL
     )) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END IF;

  IF v_salon_id IS NULL OR v_requested_start IS NULL
     OR length(v_client_phone) < 7
     OR length(trim(coalesce(v_customer->>'name', ''))) NOT BETWEEN 1 AND 120
     OR trim(v_customer->>'name') ~ '[<>{}=&;]'
     OR (v_client_email IS NOT NULL AND (
       length(v_client_email) > 254
       OR v_client_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     ))
     OR pg_catalog.jsonb_typeof(v_lines_input) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(v_lines_input) NOT BETWEEN 1 AND 5 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END IF;

  SELECT coalesce(pff.enabled, false)
  INTO v_platform_enabled
  FROM public.platform_flags pff
  WHERE pff.key = 'feature_multi_service_booking';
  v_platform_enabled := coalesce(v_platform_enabled, false);

  SELECT
    s.feature_flags->'multi_service_booking_enabled' = 'true'::jsonb,
    s.archived_at,
    coalesce(nullif(trim(s.currency_code), ''), 'USD'),
    s.tax_lines,
    coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles'),
    s.opening_hours,
    coalesce(s.resources_enabled, false),
    coalesce(s.phone_otp_enabled, false),
    coalesce(s.noshow_protection_enabled, false),
    nullif(trim(s.payment_provider), '')
  INTO v_salon_enabled, v_salon_archived, v_currency, v_tax_lines, v_timezone,
    v_opening_hours, v_resources_enabled, v_phone_otp_enabled,
    v_noshow_protection_enabled, v_payment_provider
  FROM public.salons s
  WHERE s.id = v_salon_id;
  IF NOT FOUND OR v_salon_archived IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_reference');
  END IF;
  -- Phase A has no authoritative payment/deposit/no-show sequence contract.
  -- This is re-read while create holds the salon lock, closing the app policy
  -- precheck TOCTOU without weakening quote/readiness behavior.
  IF v_noshow_protection_enabled OR v_payment_provider IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'payment_not_supported');
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.platform_settings ps
    WHERE ps.id = 'platform' AND ps.multi_service_booking_qa_salon_id = v_salon_id
  ) INTO v_qa_allowlisted;
  SELECT (
    count(*) FILTER (
      WHERE svc.deleted_at IS NULL AND svc.is_addon IS FALSE
        AND svc.price_cents >= 0 AND svc.duration_minutes > 0
        AND svc.buffer_minutes >= 0 AND svc.prep_minutes BETWEEN 0 AND 180
    ) >= 2
    AND EXISTS (
      SELECT 1 FROM public.staff st
      WHERE st.salon_id = v_salon_id AND st.status = 'active' AND st.deleted_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.services required
      WHERE required.salon_id = v_salon_id
        AND required.deleted_at IS NULL AND required.is_addon IS FALSE
        AND EXISTS (
          SELECT 1 FROM public.staff_services configured
          JOIN public.staff configured_staff ON configured_staff.id = configured.staff_id
          WHERE configured_staff.salon_id = v_salon_id
            AND configured_staff.status = 'active' AND configured_staff.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.staff_services ss
          JOIN public.staff capable ON capable.id = ss.staff_id
          WHERE ss.service_id = required.id
            AND capable.salon_id = v_salon_id
            AND capable.status = 'active' AND capable.deleted_at IS NULL
        )
    )
    AND (NOT v_resources_enabled OR EXISTS (
      SELECT 1 FROM public.salon_resources r
      WHERE r.salon_id = v_salon_id AND r.status = 'active' AND r.deleted_at IS NULL
    ))
  ) INTO v_catalog_ready
  FROM public.services svc
  WHERE svc.salon_id = v_salon_id;

  IF NOT v_platform_enabled OR NOT coalesce(v_salon_enabled, false)
     OR NOT coalesce(v_qa_allowlisted, false)
     OR NOT coalesce(v_catalog_ready, false) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'feature_disabled',
      'readiness', pg_catalog.jsonb_build_object(
        'contract_version', 1,
        'schedule_model', 'segments_v1',
        'platform_enabled', v_platform_enabled,
        'salon_enabled', coalesce(v_salon_enabled, false),
        'qa_allowlisted', coalesce(v_qa_allowlisted, false),
        'catalog_ready', coalesce(v_catalog_ready, false),
        'ready', false
      )
    );
  END IF;
  IF pg_catalog.jsonb_typeof(v_tax_lines) IS DISTINCT FROM 'array' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
  END IF;

  IF p_lock_claims THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'booking-sequence-capacity:' || v_salon_id::text, 0
      )
    );
    PERFORM p.key FROM public.platform_flags p
    WHERE p.key = 'feature_multi_service_booking' FOR UPDATE;
    PERFORM ps.id FROM public.platform_settings ps
    WHERE ps.id = 'platform' FOR UPDATE;
    SELECT coalesce(p.enabled, false) INTO v_platform_enabled
    FROM public.platform_flags p WHERE p.key = 'feature_multi_service_booking';
    SELECT
      s.feature_flags->'multi_service_booking_enabled' = 'true'::jsonb,
      s.archived_at, s.tax_lines
    INTO v_salon_enabled, v_salon_archived, v_tax_lines
    FROM public.salons s WHERE s.id = v_salon_id FOR UPDATE;
    IF NOT coalesce(v_platform_enabled, false)
       OR NOT coalesce(v_salon_enabled, false)
       OR v_salon_archived IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'feature_disabled');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.platform_settings ps
      WHERE ps.id = 'platform' AND ps.multi_service_booking_qa_salon_id = v_salon_id) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'feature_disabled');
    END IF;
    PERFORM svc.id
    FROM public.services svc
    WHERE svc.id IN (
      SELECT (l.value->>'service_id')::uuid
      FROM pg_catalog.jsonb_array_elements(v_lines_input) l(value)
      UNION
      SELECT a.value::uuid
      FROM pg_catalog.jsonb_array_elements(v_lines_input) l(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
        coalesce(l.value->'addon_service_ids', '[]'::jsonb)
      ) a(value)
    )
    ORDER BY svc.id FOR UPDATE;
    PERFORM p.id FROM public.promotions p
    WHERE p.salon_id = v_salon_id AND p.active IS TRUE
    ORDER BY p.id FOR UPDATE;
    PERFORM ps.id FROM public.promotion_services ps
    JOIN public.promotions p ON p.id = ps.promotion_id
    WHERE p.salon_id = v_salon_id AND p.active IS TRUE
    ORDER BY ps.id FOR UPDATE OF ps;
  END IF;

  IF v_voucher_code IS NOT NULL THEN
    SELECT v.id INTO v_voucher_id
    FROM public.vouchers v
    WHERE v.salon_id = v_salon_id AND upper(v.code) = v_voucher_code;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'voucher_invalid');
    END IF;
  END IF;

  -- same_staff_for_all is an intersection, not a first-line guess. An explicit
  -- UUID on any line fixes the common candidate; conflicting explicit UUIDs
  -- fail before schedule/pricing resolution.
  IF v_same_staff THEN
    BEGIN
      SELECT count(DISTINCT e.value->>'staff_preference'),
             min(e.value->>'staff_preference')
      INTO v_ord, v_staff_preference
      FROM pg_catalog.jsonb_array_elements(v_lines_input) e(value)
      WHERE e.value->>'staff_preference' IS DISTINCT FROM 'any';
      IF v_ord > 1 THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'same_staff_mismatch');
      END IF;
      v_common_staff_id := nullif(v_staff_preference, '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_line');
    END;
  END IF;

  v_customer_start := v_requested_start;
  FOR v_line_input, v_ord IN
    SELECT e.value, e.ordinality::integer
    FROM pg_catalog.jsonb_array_elements(v_lines_input)
      WITH ORDINALITY AS e(value, ordinality)
    ORDER BY e.ordinality
  LOOP
    v_position := v_ord - 1;
    IF pg_catalog.jsonb_typeof(v_line_input) <> 'object'
       OR (v_line_input - ARRAY[
         'line_id', 'position', 'service_id', 'staff_preference',
         'preferred_resource_id', 'addon_service_ids'
       ]::text[]) <> '{}'::jsonb THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_line');
    END IF;
    BEGIN
      v_line_id := (v_line_input->>'line_id')::uuid;
      IF (v_line_input->>'position')::integer <> v_position THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_line_order');
      END IF;
      v_service_id := (v_line_input->>'service_id')::uuid;
      v_staff_preference := v_line_input->>'staff_preference';
      v_explicit_staff_id := CASE WHEN v_staff_preference = 'any' THEN NULL
        ELSE v_staff_preference::uuid END;
      v_resource_id := nullif(v_line_input->>'preferred_resource_id', '')::uuid;
      IF v_line_input->'addon_service_ids' IS NULL THEN
        v_addon_ids := ARRAY[]::uuid[];
      ELSIF pg_catalog.jsonb_typeof(v_line_input->'addon_service_ids') = 'array' THEN
        SELECT coalesce(array_agg(a.value::uuid ORDER BY a.ordinality), ARRAY[]::uuid[])
        INTO v_addon_ids
        FROM pg_catalog.jsonb_array_elements_text(v_line_input->'addon_service_ids')
          WITH ORDINALITY a(value, ordinality);
      ELSE
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_addon');
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_line');
    END;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) prior(value)
      WHERE prior.value->>'line_id' = v_line_id::text
    ) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'duplicate_line_id');
    END IF;
    IF pg_catalog.cardinality(v_addon_ids) > 8
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_addon_ids) x(id) WHERE x.id IS NULL)
       OR (SELECT count(DISTINCT x.id) FROM pg_catalog.unnest(v_addon_ids) x(id))
          <> pg_catalog.cardinality(v_addon_ids) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_addon');
    END IF;

    SELECT s.duration_minutes, s.prep_minutes, s.name, s.category
    INTO v_service_duration, v_prep_minutes, v_service_name, v_service_category
    FROM public.services s
    WHERE s.id = v_service_id
      AND s.salon_id = v_salon_id
      AND s.deleted_at IS NULL
      AND s.is_addon IS FALSE
      AND s.duration_minutes BETWEEN 1 AND 1440
      AND s.price_cents >= 0;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_reference');
    END IF;

    SELECT s.buffer_minutes + coalesce(sum(
      CASE WHEN a.addon_timing = 'concurrent' THEN 0
           ELSE a.duration_minutes + a.buffer_minutes END
    ), 0)::integer
    INTO v_sequence_extra
    FROM public.services s
    LEFT JOIN pg_catalog.unnest(v_addon_ids) req(id) ON true
    LEFT JOIN public.services a ON a.id = req.id
      AND a.salon_id = v_salon_id AND a.deleted_at IS NULL AND a.is_addon IS TRUE
    WHERE s.id = v_service_id
    GROUP BY s.buffer_minutes;
    v_expected_end := v_customer_start
      + pg_catalog.make_interval(mins => v_service_duration + v_sequence_extra);
    v_expected_block_extra := v_sequence_extra;
    v_occupied_start := v_customer_start
      - pg_catalog.make_interval(mins => v_prep_minutes);

    IF v_resource_id IS NULL AND v_resources_enabled THEN
      v_search_minutes := 0;
      <<resource_search>>
      LOOP
      v_occupied_start := v_customer_start
        - pg_catalog.make_interval(mins => v_prep_minutes);
      v_expected_end := v_customer_start
        + pg_catalog.make_interval(mins => v_service_duration + v_expected_block_extra);
      SELECT r.id INTO v_resource_id
      FROM public.salon_resources r
      WHERE r.salon_id = v_salon_id AND r.status = 'active' AND r.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.bookings b
          WHERE b.salon_id = v_salon_id AND b.schedule_model = 'single'
            AND b.resource_id = r.id
            AND b.status NOT IN ('cancelled', 'no_show', 'completed')
            AND pg_catalog.tstzrange(b.start_time_utc, b.end_time_utc, '[)')
              && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.booking_service_segments seg
          WHERE seg.salon_id = v_salon_id AND seg.resource_id = r.id
            AND seg.booking_id IS DISTINCT FROM v_exclude_booking_id
            AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
            AND pg_catalog.tstzrange(seg.occupied_start_utc, seg.occupied_end_utc, '[)')
              && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) prior(value)
          WHERE prior.value->>'resource_id' = r.id::text
            AND pg_catalog.tstzrange(
              (prior.value->>'occupied_start_utc')::timestamptz,
              (prior.value->>'occupied_end_utc')::timestamptz, '[)'
            ) && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
        )
      ORDER BY r.id LIMIT 1;
      IF v_resource_id IS NULL THEN
        IF v_position > 0 AND v_search_minutes < 720 THEN
          v_customer_start := v_customer_start + interval '1 minute';
          v_search_minutes := v_search_minutes + 1;
          CONTINUE resource_search;
        END IF;
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'no_resource_available');
      END IF;
      EXIT resource_search;
      END LOOP resource_search;
    END IF;

    IF v_resource_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.salon_resources r
      WHERE r.id = v_resource_id AND r.salon_id = v_salon_id
        AND r.status = 'active' AND r.deleted_at IS NULL
    ) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_resource');
    END IF;

    IF v_same_staff AND v_common_staff_id IS NOT NULL THEN
      v_staff_id := v_common_staff_id;
      IF v_explicit_staff_id IS NOT NULL AND v_explicit_staff_id <> v_staff_id THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'same_staff_mismatch');
      END IF;
    ELSE
      v_staff_id := v_explicit_staff_id;
    END IF;

    -- Determine a staff candidate before pricing; the authoritative single-line
    -- resolver repeats active/capability validation. Existing and earlier
    -- requested capacity is filtered here; exclusion constraints close races.
    -- For a later line, search candidate minutes in ascending order and choose
    -- the lowest stable staff UUID at the first minute with capacity. This is
    -- the required earliest-completion-then-UUID rule for `any`.
    IF v_staff_id IS NULL THEN
      v_search_minutes := 0;
      <<any_staff_search>>
      LOOP
      SELECT st.id INTO v_staff_id
      FROM public.staff st
      WHERE st.salon_id = v_salon_id
        AND st.status = 'active'
        AND st.deleted_at IS NULL
        AND (
          NOT EXISTS (
            SELECT 1 FROM public.staff_services ss0
            JOIN public.staff st0 ON st0.id = ss0.staff_id
            WHERE st0.salon_id = v_salon_id
              AND st0.status = 'active' AND st0.deleted_at IS NULL
          )
          OR (
            SELECT count(DISTINCT ss.service_id)
            FROM public.staff_services ss
            WHERE ss.staff_id = st.id
              AND ss.service_id = ANY(ARRAY[v_service_id]::uuid[] || v_addon_ids)
          ) = pg_catalog.cardinality(ARRAY[v_service_id]::uuid[] || v_addon_ids)
        )
        AND (
          NOT v_same_staff OR NOT EXISTS (
            SELECT requested.service_id
            FROM (
              SELECT (l.value->>'service_id')::uuid AS service_id
              FROM pg_catalog.jsonb_array_elements(v_lines_input) l(value)
              UNION
              SELECT a.value::uuid
              FROM pg_catalog.jsonb_array_elements(v_lines_input) l(value)
              CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
                coalesce(l.value->'addon_service_ids', '[]'::jsonb)
              ) a(value)
            ) requested
            WHERE EXISTS (
              SELECT 1 FROM public.staff_services any_map
              JOIN public.staff mapped ON mapped.id = any_map.staff_id
              WHERE mapped.salon_id = v_salon_id
                AND mapped.status = 'active' AND mapped.deleted_at IS NULL
            ) AND NOT EXISTS (
              SELECT 1 FROM public.staff_services ss
              WHERE ss.staff_id = st.id AND ss.service_id = requested.service_id
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.bookings b
          WHERE b.salon_id = v_salon_id AND b.schedule_model = 'single'
            AND b.staff_id = st.id
            AND b.status NOT IN ('cancelled', 'no_show', 'completed')
            AND pg_catalog.tstzrange(b.start_time_utc, b.end_time_utc, '[)')
              && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.booking_service_segments seg
          WHERE seg.salon_id = v_salon_id AND seg.staff_id = st.id
            AND seg.booking_id IS DISTINCT FROM v_exclude_booking_id
            AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
            AND pg_catalog.tstzrange(seg.occupied_start_utc, seg.occupied_end_utc, '[)')
              && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.staff_unavailability su
          WHERE su.salon_id = v_salon_id AND su.staff_id = st.id
            AND su.date = (v_occupied_start AT TIME ZONE v_timezone)::date
        )
        AND (
          NOT EXISTS (SELECT 1 FROM public.staff_shifts any_shift
            WHERE any_shift.staff_id = st.id)
          OR EXISTS (
            SELECT 1 FROM public.staff_shifts sh
            WHERE sh.staff_id = st.id AND sh.salon_id = v_salon_id
              AND sh.is_active IS TRUE
              AND sh.day_of_week = (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[
                extract(dow FROM (v_occupied_start AT TIME ZONE v_timezone))::integer + 1
              ]
              AND (v_occupied_start AT TIME ZONE v_timezone)::date
                = (v_expected_end AT TIME ZONE v_timezone)::date
              AND (v_occupied_start AT TIME ZONE v_timezone)::time >= sh.start_time::time
              AND (v_expected_end AT TIME ZONE v_timezone)::time <= sh.end_time::time
              AND NOT (sh.break_start_time IS NOT NULL AND sh.break_end_time IS NOT NULL
                AND (v_occupied_start AT TIME ZONE v_timezone)::time < sh.break_end_time
                AND (v_expected_end AT TIME ZONE v_timezone)::time > sh.break_start_time)
          )
        )
      ORDER BY st.id
      LIMIT 1;
      IF v_staff_id IS NOT NULL THEN
        EXIT any_staff_search;
      END IF;
      IF v_position > 0 AND v_search_minutes < 720 THEN
        v_customer_start := v_customer_start + interval '1 minute';
        v_search_minutes := v_search_minutes + 1;
        v_occupied_start := v_customer_start
          - pg_catalog.make_interval(mins => v_prep_minutes);
        v_expected_end := v_customer_start
          + pg_catalog.make_interval(mins => v_service_duration + v_expected_block_extra);
        CONTINUE any_staff_search;
      END IF;
      EXIT any_staff_search;
      END LOOP any_staff_search;
    END IF;
    IF v_staff_id IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'no_staff_available');
    END IF;
    IF v_same_staff AND v_common_staff_id IS NULL THEN
      v_common_staff_id := v_staff_id;
    END IF;
    IF p_lock_claims THEN
      PERFORM st.id FROM public.staff st
      WHERE st.id = v_staff_id AND st.salon_id = v_salon_id
        AND st.status = 'active' AND st.deleted_at IS NULL
      FOR UPDATE;
      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'staff_state_changed');
      END IF;
    END IF;

    -- Customer work remains ordered. If this line reuses capacity, move its
    -- customer start just enough that its prep begins after the prior occupied
    -- interval. Different capacity may prepare during prior customer work.
    SELECT greatest(
      v_customer_start,
      coalesce(max((prior.value->>'occupied_end_utc')::timestamptz)
        + pg_catalog.make_interval(mins => v_prep_minutes), v_customer_start)
    )
    INTO v_customer_start
    FROM pg_catalog.jsonb_array_elements(v_lines) prior(value)
    WHERE prior.value->>'staff_id' = v_staff_id::text
       OR (v_resource_id IS NOT NULL AND prior.value->>'resource_id' = v_resource_id::text);

    -- Ask the existing authoritative line resolver for catalog, promotions,
    -- add-ons, hours, active staff, and capability truth. End is derived from
    -- immutable catalog data, never caller money/duration.
    v_search_minutes := 0;
    <<sequence_slot_search>>
    LOOP
    v_expected_end := v_customer_start
      + pg_catalog.make_interval(mins => v_service_duration + v_expected_block_extra);
    v_occupied_start := v_customer_start
      - pg_catalog.make_interval(mins => v_prep_minutes);

    -- Staff search may have moved a later line. Re-resolve an `any` resource
    -- at that exact candidate minute so an initially selected resource cannot
    -- force a later finish while another active resource is already free.
    IF v_resources_enabled
       AND nullif(v_line_input->>'preferred_resource_id', '') IS NULL THEN
      v_resource_id := NULL;
      IF p_lock_claims THEN
        SELECT r.id INTO v_resource_id
        FROM public.salon_resources r
        WHERE r.salon_id = v_salon_id
          AND r.status = 'active' AND r.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.bookings b
            WHERE b.salon_id = v_salon_id AND b.schedule_model = 'single'
              AND b.resource_id = r.id
              AND b.status NOT IN ('cancelled', 'no_show', 'completed')
              AND pg_catalog.tstzrange(b.start_time_utc, b.end_time_utc, '[)')
                && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.booking_service_segments seg
            WHERE seg.salon_id = v_salon_id AND seg.resource_id = r.id
              AND seg.booking_id IS DISTINCT FROM v_exclude_booking_id
              AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
              AND pg_catalog.tstzrange(seg.occupied_start_utc, seg.occupied_end_utc, '[)')
                && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) prior(value)
            WHERE prior.value->>'resource_id' = r.id::text
              AND pg_catalog.tstzrange(
                (prior.value->>'occupied_start_utc')::timestamptz,
                (prior.value->>'occupied_end_utc')::timestamptz, '[)'
              ) && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
          )
        ORDER BY r.id LIMIT 1 FOR UPDATE;
      ELSE
        SELECT r.id INTO v_resource_id
        FROM public.salon_resources r
        WHERE r.salon_id = v_salon_id
          AND r.status = 'active' AND r.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.bookings b
            WHERE b.salon_id = v_salon_id AND b.schedule_model = 'single'
              AND b.resource_id = r.id
              AND b.status NOT IN ('cancelled', 'no_show', 'completed')
              AND pg_catalog.tstzrange(b.start_time_utc, b.end_time_utc, '[)')
                && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.booking_service_segments seg
            WHERE seg.salon_id = v_salon_id AND seg.resource_id = r.id
              AND seg.booking_id IS DISTINCT FROM v_exclude_booking_id
              AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
              AND pg_catalog.tstzrange(seg.occupied_start_utc, seg.occupied_end_utc, '[)')
                && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) prior(value)
            WHERE prior.value->>'resource_id' = r.id::text
              AND pg_catalog.tstzrange(
                (prior.value->>'occupied_start_utc')::timestamptz,
                (prior.value->>'occupied_end_utc')::timestamptz, '[)'
              ) && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
          )
        ORDER BY r.id LIMIT 1;
      END IF;
      IF v_resource_id IS NULL THEN
        IF v_position > 0 AND v_search_minutes < 720 THEN
          v_customer_start := v_customer_start + interval '1 minute';
          v_search_minutes := v_search_minutes + 1;
          CONTINUE sequence_slot_search;
        END IF;
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'no_resource_available');
      END IF;
    ELSIF v_resource_id IS NOT NULL AND p_lock_claims THEN
      PERFORM r.id FROM public.salon_resources r
      WHERE r.id = v_resource_id AND r.salon_id = v_salon_id
        AND r.status = 'active' AND r.deleted_at IS NULL
      FOR UPDATE;
      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'resource_state_changed');
      END IF;
    END IF;

    v_quote := public.resolve_public_booking_pricing(
      v_salon_id, v_service_id, v_staff_id,
      v_customer_start, v_expected_end, v_addon_ids,
      NULL, NULL, v_client_phone, NULL, false, false
    );
    IF coalesce(v_quote->>'success', 'false') <> 'true' THEN
      RETURN v_quote;
    END IF;
    v_trailing_buffer := (v_quote->>'trailing_buffer_minutes')::integer;
    v_occupied_end := v_expected_end;
    v_customer_end := v_expected_end
      - pg_catalog.make_interval(mins => v_trailing_buffer);
    v_sequence_extra := extract(epoch FROM (v_customer_end - v_customer_start))::integer / 60
      - v_service_duration;
    IF v_sequence_extra < 0 THEN
      RAISE EXCEPTION 'sequence duration invariant failed';
    END IF;

    v_local_occupied_start := v_occupied_start AT TIME ZONE v_timezone;
    v_local_occupied_end := v_occupied_end AT TIME ZONE v_timezone;
    v_shift_day := (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[
      extract(dow FROM v_local_occupied_start)::integer + 1
    ];
    v_day_config := v_opening_hours->v_shift_day;
    BEGIN
      IF pg_catalog.jsonb_typeof(v_day_config) IS DISTINCT FROM 'object'
         OR coalesce((v_day_config->>'closed')::boolean, false)
         OR v_local_occupied_start::date <> v_local_occupied_end::date
         OR v_local_occupied_start::time < (v_day_config->>'open')::time
         OR (
           CASE WHEN v_position = pg_catalog.jsonb_array_length(v_lines_input) - 1
             THEN (v_customer_end AT TIME ZONE v_timezone)::time
             ELSE v_local_occupied_end::time
           END
         ) > (v_day_config->>'close')::time THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'outside_hours');
      END IF;
    EXCEPTION WHEN invalid_datetime_format OR invalid_text_representation THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
    END;
    IF EXISTS (
      SELECT 1 FROM public.staff_unavailability su
      WHERE su.staff_id = v_staff_id AND su.salon_id = v_salon_id
        AND su.date = v_local_occupied_start::date
    ) OR (
      EXISTS (SELECT 1 FROM public.staff_shifts any_shift WHERE any_shift.staff_id = v_staff_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.staff_shifts sh
        WHERE sh.staff_id = v_staff_id AND sh.salon_id = v_salon_id
          AND sh.is_active IS TRUE AND sh.day_of_week = v_shift_day
          AND v_local_occupied_start::date = v_local_occupied_end::date
          AND v_local_occupied_start::time >= sh.start_time::time
          AND v_local_occupied_end::time <= sh.end_time::time
          AND NOT (
            sh.break_start_time IS NOT NULL AND sh.break_end_time IS NOT NULL
            AND v_local_occupied_start::time < sh.break_end_time
            AND v_local_occupied_end::time > sh.break_start_time
          )
      )
    ) THEN
      IF v_position > 0 AND v_search_minutes < 720 THEN
        v_customer_start := v_customer_start + interval '1 minute';
        v_search_minutes := v_search_minutes + 1;
        CONTINUE sequence_slot_search;
      END IF;
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'staff_unavailable');
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.salon_id = v_salon_id AND b.schedule_model = 'single'
        AND b.status NOT IN ('cancelled', 'no_show', 'completed')
        AND (b.staff_id = v_staff_id OR (v_resource_id IS NOT NULL AND b.resource_id = v_resource_id))
        AND pg_catalog.tstzrange(b.start_time_utc, b.end_time_utc, '[)')
          && pg_catalog.tstzrange(v_occupied_start, v_occupied_end, '[)')
    ) OR EXISTS (
      SELECT 1 FROM public.booking_service_segments seg
      WHERE seg.salon_id = v_salon_id
        AND seg.booking_id IS DISTINCT FROM v_exclude_booking_id
        AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
        AND (seg.staff_id = v_staff_id OR (v_resource_id IS NOT NULL AND seg.resource_id = v_resource_id))
        AND pg_catalog.tstzrange(seg.occupied_start_utc, seg.occupied_end_utc, '[)')
          && pg_catalog.tstzrange(v_occupied_start, v_occupied_end, '[)')
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) prior(value)
      WHERE (prior.value->>'staff_id' = v_staff_id::text
          OR (v_resource_id IS NOT NULL AND prior.value->>'resource_id' = v_resource_id::text))
        AND pg_catalog.tstzrange(
          (prior.value->>'occupied_start_utc')::timestamptz,
          (prior.value->>'occupied_end_utc')::timestamptz, '[)'
        ) && pg_catalog.tstzrange(v_occupied_start, v_occupied_end, '[)')
    ) THEN
      IF v_position > 0 AND v_search_minutes < 720 THEN
        v_customer_start := v_customer_start + interval '1 minute';
        v_search_minutes := v_search_minutes + 1;
        CONTINUE sequence_slot_search;
      END IF;
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'slot_conflict');
    END IF;
    EXIT sequence_slot_search;
    END LOOP sequence_slot_search;

    v_lines := v_lines || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'position', v_position,
        'line_id', v_line_id,
        'service_id', v_service_id,
        'service_name', v_service_name,
        'staff_name', (SELECT st.name FROM public.staff st WHERE st.id = v_staff_id),
        'staff_id', v_staff_id,
        'resolved_staff_id', v_staff_id,
        'resource_id', v_resource_id,
        'resolved_resource_id', v_resource_id,
        'customer_start_utc', v_customer_start,
        'customer_end_utc', v_customer_end,
        'service_start_utc', v_customer_start,
        'service_end_utc', v_customer_end,
        'occupied_start_utc', v_occupied_start,
        'occupied_end_utc', v_occupied_end,
        'prep_minutes', v_prep_minutes,
        'duration_minutes', v_service_duration + v_sequence_extra,
        'service_duration_minutes', v_service_duration,
        'sequential_addon_minutes', v_sequence_extra,
        'trailing_buffer_minutes', v_trailing_buffer,
        'buffer_minutes', v_trailing_buffer,
        'addon_service_ids', v_quote->'addon_service_ids',
        'addon_lines', v_quote->'addon_lines',
        'first_addon_id', v_quote->'first_addon_id',
        'promo_id', v_quote->'promo_id',
        'promo_name', v_quote->'promo_name',
        'original_service_price_cents', (v_quote->>'original_price_cents')::integer,
        'service_pre_voucher_cents', (v_quote->>'service_pre_voucher_cents')::integer,
        'addon_pre_voucher_cents', (v_quote->>'addon_pre_voucher_cents')::integer,
        'promo_discount_cents', coalesce(
          (v_quote->>'promo_discount_cents')::integer, 0
        ),
        'service_category', v_service_category
      )
    );
    v_customer_start := v_customer_end;
  END LOOP;

  IF p_lock_claims THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('public-booking-client:' || v_client_phone, 0)
    );
    PERFORM cp.id FROM public.client_profiles cp
    WHERE cp.phone = v_client_phone FOR UPDATE;
  END IF;
  SELECT cp.id, cp.email_discount_claimed_at
  INTO v_profile_id, v_email_claimed_at
  FROM public.client_profiles cp WHERE cp.phone = v_client_phone;

  IF v_apply_email AND v_client_email IS NOT NULL
     AND (v_profile_id IS NULL OR v_email_claimed_at IS NULL) THEN
    v_email := least(200, (v_lines->0->>'service_pre_voucher_cents')::integer);
  END IF;

  FOR v_line IN
    SELECT value FROM pg_catalog.jsonb_array_elements(v_lines)
    ORDER BY (value->>'position')::integer
  LOOP
    v_email_alloc := CASE WHEN (v_line->>'position')::integer = 0 THEN v_email ELSE 0 END;
    v_line_pre := greatest(0, (v_line->>'service_pre_voucher_cents')::integer - v_email_alloc)
      + (v_line->>'addon_pre_voucher_cents')::integer;
    v_original := v_original + (v_line->>'original_service_price_cents')::integer;
    v_promo := v_promo + (v_line->>'promo_discount_cents')::integer;
    v_pre_voucher := v_pre_voucher + v_line_pre;
  END LOOP;

  IF v_voucher_id IS NOT NULL THEN
    IF p_lock_claims THEN
      SELECT v.* INTO v_voucher FROM public.vouchers v
      WHERE v.id = v_voucher_id FOR UPDATE;
    ELSE
      SELECT v.* INTO v_voucher FROM public.vouchers v WHERE v.id = v_voucher_id;
    END IF;
    IF NOT FOUND OR v_voucher.salon_id <> v_salon_id
       OR v_voucher.revoked_at IS NOT NULL
       OR transaction_timestamp() < v_voucher.valid_from
       OR transaction_timestamp() > v_voucher.expires_at
       OR v_voucher.used_count >= v_voucher.max_uses
       OR (v_voucher.client_phone IS NOT NULL AND
           pg_catalog.regexp_replace(v_voucher.client_phone, '\D', '', 'g') <> v_client_phone)
       OR (v_voucher.client_profile_id IS NOT NULL AND
           v_voucher.client_profile_id IS DISTINCT FROM v_profile_id) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'voucher_invalid');
    END IF;

    FOR v_line IN SELECT value FROM pg_catalog.jsonb_array_elements(v_lines)
    LOOP
      v_is_eligible := (
        coalesce(pg_catalog.cardinality(v_voucher.applicable_service_ids), 0) = 0
        OR (v_line->>'service_id')::uuid = ANY(v_voucher.applicable_service_ids)
      ) AND (
        v_voucher.applicable_service_category IS NULL
        OR v_line->>'service_category' = v_voucher.applicable_service_category
      );
      IF v_is_eligible THEN
        v_eligible_total := v_eligible_total
          + greatest(0, (v_line->>'service_pre_voucher_cents')::integer
              - CASE WHEN (v_line->>'position')::integer = 0 THEN v_email ELSE 0 END)
          + (v_line->>'addon_pre_voucher_cents')::integer;
      END IF;
    END LOOP;
    IF v_pre_voucher < coalesce(v_voucher.min_spend_cents, 0)
       OR v_eligible_total < 1 THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'voucher_invalid');
    END IF;
    IF v_voucher.free_service_id IS NOT NULL THEN
      SELECT greatest(0, (line.value->>'service_pre_voucher_cents')::integer
        - CASE WHEN (line.value->>'position')::integer = 0 THEN v_email ELSE 0 END)
      INTO v_voucher_discount
      FROM pg_catalog.jsonb_array_elements(v_lines) line(value)
      WHERE (line.value->>'service_id')::uuid = v_voucher.free_service_id
        AND (coalesce(pg_catalog.cardinality(v_voucher.applicable_service_ids), 0) = 0
          OR (line.value->>'service_id')::uuid = ANY(v_voucher.applicable_service_ids))
        AND (v_voucher.applicable_service_category IS NULL
          OR line.value->>'service_category' = v_voucher.applicable_service_category)
      ORDER BY (line.value->>'position')::integer
      LIMIT 1;
      IF NOT FOUND OR v_voucher_discount < 1 THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'voucher_invalid');
      END IF;
    ELSIF v_voucher.percent_off IS NOT NULL AND v_voucher.amount_off_cents IS NULL THEN
      v_voucher_discount := floor(v_eligible_total::numeric * v_voucher.percent_off / 100)::integer;
    ELSIF v_voucher.amount_off_cents IS NOT NULL AND v_voucher.percent_off IS NULL THEN
      v_voucher_discount := least(v_eligible_total, v_voucher.amount_off_cents);
    ELSE
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'voucher_invalid');
    END IF;
  END IF;

  IF v_voucher_id IS NOT NULL
     AND v_voucher.free_service_id IS NULL
     AND v_voucher_discount > 0 THEN
    WITH eligible AS (
      SELECT
        (l.value->>'position')::integer AS position,
        l.value->>'line_id' AS line_id,
        greatest(0, (l.value->>'service_pre_voucher_cents')::integer
          - CASE WHEN (l.value->>'position')::integer = 0 THEN v_email ELSE 0 END)
          + (l.value->>'addon_pre_voucher_cents')::integer AS eligible_cents
      FROM pg_catalog.jsonb_array_elements(v_lines) l(value)
      WHERE (
        coalesce(pg_catalog.cardinality(v_voucher.applicable_service_ids), 0) = 0
        OR (l.value->>'service_id')::uuid = ANY(v_voucher.applicable_service_ids)
      ) AND (
        v_voucher.applicable_service_category IS NULL
        OR l.value->>'service_category' = v_voucher.applicable_service_category
      )
    ), shares AS (
      SELECT *,
        floor(v_voucher_discount::numeric * eligible_cents / v_eligible_total)::integer AS floor_cents,
        (v_voucher_discount::numeric * eligible_cents / v_eligible_total)
          - floor(v_voucher_discount::numeric * eligible_cents / v_eligible_total) AS remainder
      FROM eligible WHERE eligible_cents > 0
    ), ranked AS (
      SELECT *, row_number() OVER (ORDER BY remainder DESC, position, line_id) AS remainder_rank,
        v_voucher_discount - sum(floor_cents) OVER () AS cents_left
      FROM shares
    )
    SELECT coalesce(pg_catalog.jsonb_object_agg(
      position::text,
      floor_cents + CASE WHEN remainder_rank <= cents_left THEN 1 ELSE 0 END
    ), '{}'::jsonb)
    INTO v_voucher_allocations
    FROM ranked;
  END IF;

  v_remaining := v_voucher_discount;
  FOR v_line IN
    SELECT value FROM pg_catalog.jsonb_array_elements(v_lines)
    ORDER BY (value->>'position')::integer
  LOOP
    v_email_alloc := CASE WHEN (v_line->>'position')::integer = 0 THEN v_email ELSE 0 END;
    v_service_pre := greatest(0, (v_line->>'service_pre_voucher_cents')::integer - v_email_alloc);
    v_addon_pre := (v_line->>'addon_pre_voucher_cents')::integer;
    v_is_eligible := v_voucher_id IS NOT NULL AND (
      coalesce(pg_catalog.cardinality(v_voucher.applicable_service_ids), 0) = 0
      OR (v_line->>'service_id')::uuid = ANY(v_voucher.applicable_service_ids)
    ) AND (
      v_voucher.applicable_service_category IS NULL
      OR v_line->>'service_category' = v_voucher.applicable_service_category
    );
    IF v_voucher.free_service_id IS NOT NULL THEN
      v_voucher_alloc := CASE
        WHEN NOT v_free_applied AND v_is_eligible
          AND (v_line->>'service_id')::uuid = v_voucher.free_service_id
        THEN least(v_service_pre, v_remaining) ELSE 0 END;
      IF v_voucher_alloc > 0 THEN v_free_applied := true; END IF;
    ELSE
      v_voucher_alloc := CASE WHEN v_is_eligible
        THEN coalesce((v_voucher_allocations->>(v_line->>'position'))::integer, 0)
        ELSE 0 END;
    END IF;
    v_remaining := v_remaining - v_voucher_alloc;
    v_final_service := v_service_pre - least(v_service_pre, v_voucher_alloc);
    v_final_addon := v_addon_pre - greatest(0, v_voucher_alloc - v_service_pre);
    v_line_subtotal := v_final_service + v_final_addon;
    v_subtotal := v_subtotal + v_line_subtotal;
    v_final_lines := v_final_lines || pg_catalog.jsonb_build_array(
      v_line || pg_catalog.jsonb_build_object(
        'email_discount_cents', v_email_alloc,
        'voucher_discount_cents', v_voucher_alloc,
        'service_price_cents', v_final_service,
        'addon_price_cents', v_final_addon,
        'pre_voucher_subtotal_cents', v_service_pre + v_addon_pre,
        'subtotal_cents', v_line_subtotal,
        'tax_cents', 0,
        'tax_amount_cents', 0,
        'total_cents', v_line_subtotal,
        'tax_breakdown', '[]'::jsonb
      )
    );
  END LOOP;
  IF v_remaining <> 0 OR v_subtotal <> v_pre_voucher - v_voucher_discount THEN
    RAISE EXCEPTION 'sequence voucher allocation invariant failed';
  END IF;

  FOR v_tax_line IN SELECT value FROM pg_catalog.jsonb_array_elements(v_tax_lines)
  LOOP
    IF pg_catalog.jsonb_typeof(v_tax_line) <> 'object'
       OR nullif(trim(v_tax_line->>'name'), '') IS NULL
       OR v_tax_line->'rate' IS NULL
       OR pg_catalog.jsonb_typeof(v_tax_line->'rate') <> 'number' THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
    END IF;
    v_tax_rate := (v_tax_line->>'rate')::numeric;
    v_tax_enabled := coalesce((v_tax_line->>'enabled')::boolean, true);
    IF v_tax_rate < 0 OR v_tax_rate > 1 THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
    END IF;
    IF v_tax_enabled AND v_tax_rate > 0 THEN
      v_tax_line_amount := round(v_subtotal::numeric * v_tax_rate)::integer;
      SELECT coalesce(sum(floor((l.value->>'subtotal_cents')::numeric * v_tax_rate)), 0)::integer
      INTO v_tax_floor_sum
      FROM pg_catalog.jsonb_array_elements(v_final_lines) l(value);
      v_tax_remainder_count := v_tax_line_amount - v_tax_floor_sum;
      WITH shares AS (
        SELECT l.value,
          (l.value->>'position')::integer AS position,
          floor((l.value->>'subtotal_cents')::numeric * v_tax_rate)::integer AS floor_cents,
          row_number() OVER (ORDER BY
            ((l.value->>'subtotal_cents')::numeric * v_tax_rate
              - floor((l.value->>'subtotal_cents')::numeric * v_tax_rate)) DESC,
            (l.value->>'position')::integer) AS remainder_rank
        FROM pg_catalog.jsonb_array_elements(v_final_lines) l(value)
      ), allocated AS (
        SELECT value, position, floor_cents + CASE
          WHEN remainder_rank <= v_tax_remainder_count THEN 1 ELSE 0 END AS amount_cents
        FROM shares
      )
      SELECT coalesce(pg_catalog.jsonb_agg(
        a.value || pg_catalog.jsonb_build_object(
          'tax_cents', (a.value->>'tax_cents')::integer + a.amount_cents,
          'tax_amount_cents', (a.value->>'tax_amount_cents')::integer + a.amount_cents,
          'total_cents', (a.value->>'total_cents')::integer + a.amount_cents,
          'tax_breakdown', a.value->'tax_breakdown' || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('name', trim(v_tax_line->>'name'),
              'rate', v_tax_rate, 'amount_cents', a.amount_cents)
          )
        ) ORDER BY a.position
      ), '[]'::jsonb) INTO v_final_lines FROM allocated a;
      v_tax := v_tax + v_tax_line_amount;
      v_tax_breakdown := v_tax_breakdown || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('name', trim(v_tax_line->>'name'),
          'rate', v_tax_rate, 'amount_cents', v_tax_line_amount)
      );
    END IF;
  END LOOP;
  v_total := v_subtotal + v_tax;

  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'line_id', l.value->'line_id',
      'position', (l.value->>'position')::integer,
      'service_id', l.value->'service_id',
      'resolved_staff_id', l.value->'resolved_staff_id',
      'resolved_resource_id', l.value->'resolved_resource_id',
      'prep_minutes', (l.value->>'prep_minutes')::integer,
      'duration_minutes', (l.value->>'duration_minutes')::integer,
      'buffer_minutes', (l.value->>'buffer_minutes')::integer,
      'occupied_start_utc', l.value->'occupied_start_utc',
      'service_start_utc', l.value->'service_start_utc',
      'service_end_utc', l.value->'service_end_utc',
      'occupied_end_utc', l.value->'occupied_end_utc'
    ) ORDER BY (l.value->>'position')::integer
  ), '[]'::jsonb)
  INTO v_timing_segments
  FROM pg_catalog.jsonb_array_elements(v_final_lines) l(value);

  v_material := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'schedule_model', 'segments_v1',
    'sequence_version', 1,
    'salon_id', v_salon_id,
    'requested_start_time_utc', v_requested_start,
    'parent_start_time_utc', (v_final_lines->0->>'customer_start_utc')::timestamptz,
    'parent_end_time_utc', (v_final_lines->(pg_catalog.jsonb_array_length(v_final_lines)-1)->>'customer_end_utc')::timestamptz,
    'same_staff_for_all', v_same_staff,
    'voucher_id', v_voucher_id,
    'currency', v_currency,
    'original_price_cents', v_original,
    'promo_discount_cents', v_promo,
    'email_discount_cents', v_email,
    'voucher_discount_cents', v_voucher_discount,
    'pre_voucher_subtotal_cents', v_pre_voucher,
    'subtotal_cents', v_subtotal,
    'tax_cents', v_tax,
    'tax_amount_cents', v_tax,
    'total_cents', v_total,
    'tax_breakdown', v_tax_breakdown,
    'segments', v_final_lines,
    'timing_segments', v_timing_segments,
    'readiness', pg_catalog.jsonb_build_object(
      'contract_version', 1,
      'schedule_model', 'segments_v1',
      'platform_enabled', true,
      'salon_enabled', true,
      'qa_allowlisted', true,
      'catalog_ready', true,
      'capacity_contract_ready', true,
      'ready', true
    )
  );
  v_fingerprint := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_material::text, 'UTF8'), 'sha256'), 'hex'
  );
  RETURN pg_catalog.jsonb_build_object(
    'success', true, 'code', 'quoted',
    'request_id', v_request_id,
    'pricing_fingerprint', v_fingerprint
  ) || v_material;
EXCEPTION
  WHEN exclusion_violation THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'slot_conflict');
  WHEN invalid_text_representation THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_line');
END;
$sequence_resolver$;

REVOKE ALL ON FUNCTION public.resolve_booking_sequence_pricing_and_schedule(jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_booking_sequence_pricing_and_schedule(jsonb, boolean)
  TO service_role;

CREATE OR REPLACE FUNCTION public.quote_public_booking_sequence(p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sequence_quote$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  RETURN public.resolve_booking_sequence_pricing_and_schedule(p_request, false);
END;
$sequence_quote$;

REVOKE ALL ON FUNCTION public.quote_public_booking_sequence(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_public_booking_sequence(jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.check_booking_service_sequence_shape()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sequence_shape$
DECLARE
  v_booking_id uuid := coalesce(NEW.booking_id, OLD.booking_id);
  v_count integer;
  v_min integer;
  v_max integer;
  v_parent public.bookings%ROWTYPE;
BEGIN
  SELECT b.* INTO v_parent FROM public.bookings b WHERE b.id = v_booking_id;
  IF NOT FOUND OR v_parent.schedule_model <> 'segments_v1' THEN
    RETURN coalesce(NEW, OLD);
  END IF;
  SELECT count(*), min(seg.position), max(seg.position)
  INTO v_count, v_min, v_max
  FROM public.booking_service_segments seg
  WHERE seg.booking_id = v_booking_id;
  IF v_count NOT BETWEEN 1 AND 5 OR v_min <> 0 OR v_max <> v_count - 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'sequence positions must be contiguous 0..N-1 where N is 1..5';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.booking_service_segments left_seg
    JOIN public.booking_service_segments right_seg
      ON right_seg.booking_id = left_seg.booking_id
     AND right_seg.position > left_seg.position
    WHERE left_seg.booking_id = v_booking_id
      AND pg_catalog.tstzrange(left_seg.customer_start_utc, left_seg.customer_end_utc, '[)')
        && pg_catalog.tstzrange(right_seg.customer_start_utc, right_seg.customer_end_utc, '[)')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'sequence customer-work intervals overlap';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.booking_service_segments first_seg
    JOIN public.booking_service_segments last_seg
      ON last_seg.booking_id = first_seg.booking_id AND last_seg.position = v_count - 1
    WHERE first_seg.booking_id = v_booking_id AND first_seg.position = 0
      AND v_parent.start_time_utc = first_seg.customer_start_utc
      AND v_parent.end_time_utc = last_seg.customer_end_utc
      AND v_parent.service_id = first_seg.service_id
      AND v_parent.staff_id = first_seg.staff_id
      AND v_parent.resource_id IS NOT DISTINCT FROM first_seg.resource_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'sequence parent anchor mismatch';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$sequence_shape$;

REVOKE ALL ON FUNCTION public.check_booking_service_sequence_shape()
  FROM PUBLIC, anon, authenticated;

CREATE CONSTRAINT TRIGGER check_booking_service_sequence_shape
  AFTER INSERT OR UPDATE OF booking_id, position, line_id, service_id, staff_id,
    resource_id, customer_start_utc, customer_end_utc,
    occupied_start_utc, occupied_end_utc, prep_minutes,
    service_duration_minutes, sequential_addon_minutes,
    trailing_buffer_minutes OR DELETE
  ON public.booking_service_segments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_booking_service_sequence_shape();

CREATE OR REPLACE FUNCTION public.create_public_booking_sequence(p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sequence_create$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_salon_id uuid;
  v_request_id uuid;
  v_expected_fingerprint text;
  v_otp_session_id uuid;
  v_otp_session public.phone_otp_sessions%ROWTYPE;
  v_phone_otp_enabled boolean := false;
  v_health_acknowledged boolean := false;
  v_sms_consent boolean := false;
  v_notification_language text := 'vi';
  v_health_ack_required boolean := false;
  v_locked_noshow_protection_enabled boolean := false;
  v_locked_payment_provider text;
  v_salon_slug text;
  v_digits text;
  v_email text;
  v_customer jsonb;
  v_voucher_code text;
  v_request_material jsonb;
  v_request_fingerprint text;
  v_existing public.bookings%ROWTYPE;
  v_quote jsonb;
  v_quote_fingerprint text;
  v_first jsonb;
  v_segment jsonb;
  v_addon jsonb;
  v_booking_id uuid := extensions.gen_random_uuid();
  v_segment_id uuid;
  v_segment_ids uuid[] := ARRAY[]::uuid[];
  v_profile_id uuid;
  v_voucher_id uuid;
  v_service_total integer := 0;
  v_addon_total integer := 0;
  v_addon_remaining integer;
  v_addon_persist integer;
  v_snapshot jsonb;
  v_effective_plan text;
  v_feature_flags jsonb;
  v_month_count bigint;
  v_month_start timestamptz := (
    pg_catalog.date_trunc('month', transaction_timestamp() AT TIME ZONE 'UTC')
      AT TIME ZONE 'UTC'
  );
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_request IS NULL OR pg_catalog.jsonb_typeof(p_request) <> 'object'
     OR (p_request - ARRAY[
       'contract_version', 'salon_id', 'request_id',
       'requested_start_time_utc', 'lines', 'same_staff_for_all',
       'voucher_code', 'customer', 'apply_email_discount',
       'expected_pricing_fingerprint', 'otp_session_id',
       'health_acknowledged', 'sms_consent', 'notification_language'
     ]::text[]) <> '{}'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END IF;
  BEGIN
    IF (p_request->>'contract_version')::integer <> 1 THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unsupported_contract');
    END IF;
    v_salon_id := (p_request->>'salon_id')::uuid;
    v_request_id := (p_request->>'request_id')::uuid;
    IF p_request ? 'otp_session_id'
       AND p_request->'otp_session_id' <> 'null'::jsonb
       AND pg_catalog.jsonb_typeof(p_request->'otp_session_id') <> 'string' THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
    END IF;
    v_otp_session_id := nullif(trim(coalesce(p_request->>'otp_session_id', '')), '')::uuid;
    IF p_request ? 'health_acknowledged'
       AND pg_catalog.jsonb_typeof(p_request->'health_acknowledged') <> 'boolean' THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
    END IF;
    v_health_acknowledged := coalesce(
      (p_request->>'health_acknowledged')::boolean, false
    );
    IF p_request ? 'sms_consent'
       AND pg_catalog.jsonb_typeof(p_request->'sms_consent') <> 'boolean' THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
    END IF;
    v_sms_consent := coalesce((p_request->>'sms_consent')::boolean, false);
    IF p_request ? 'notification_language'
       AND (pg_catalog.jsonb_typeof(p_request->'notification_language') <> 'string'
         OR p_request->>'notification_language' NOT IN ('en','vi')) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
    END IF;
    v_notification_language := coalesce(p_request->>'notification_language', 'vi');
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END;
  v_expected_fingerprint := p_request->>'expected_pricing_fingerprint';
  IF v_salon_id IS NULL OR v_request_id IS NULL
     OR v_expected_fingerprint IS NULL
     OR v_expected_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'missing_pricing_fingerprint'
    );
  END IF;
  v_customer := p_request->'customer';
  IF pg_catalog.jsonb_typeof(v_customer) IS DISTINCT FROM 'object'
     OR (v_customer - ARRAY['name', 'phone', 'email']::text[]) <> '{}'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END IF;
  v_digits := pg_catalog.regexp_replace(coalesce(v_customer->>'phone', ''), '\D', '', 'g');
  v_email := nullif(lower(trim(coalesce(v_customer->>'email', ''))), '');
  v_voucher_code := nullif(upper(trim(coalesce(p_request->>'voucher_code', ''))), '');
  v_request_material := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'salon_id', v_salon_id,
    'request_id', v_request_id,
    'requested_start_time_utc', p_request->'requested_start_time_utc',
    'lines', p_request->'lines',
    'same_staff_for_all', coalesce((p_request->>'same_staff_for_all')::boolean, false),
    'voucher_code', v_voucher_code,
    'customer', pg_catalog.jsonb_build_object(
      'name', trim(coalesce(v_customer->>'name', '')),
      'phone', v_digits,
      'email', v_email
    ),
    'apply_email_discount', coalesce((p_request->>'apply_email_discount')::boolean, false),
    'health_acknowledged', v_health_acknowledged,
    'sms_consent', v_sms_consent,
    'notification_language', v_notification_language,
    'expected_pricing_fingerprint', v_expected_fingerprint
  );
  -- A supplied OTP session is additionally bound to the canonical request
  -- identity so a response-loss replay cannot switch bearers.
  IF v_otp_session_id IS NOT NULL THEN
    v_request_material := v_request_material || pg_catalog.jsonb_build_object(
      'otp_session_id', v_otp_session_id
    );
  END IF;
  v_request_fingerprint := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_request_material::text, 'UTF8'), 'sha256'), 'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'booking-sequence-idempotency:' || v_salon_id::text || ':' || v_request_id::text,
      0
    )
  );
  SELECT b.* INTO v_existing
  FROM public.bookings b
  WHERE b.salon_id = v_salon_id
    AND b.idempotency_key = v_request_id
    AND b.group_id IS NULL
    AND b.recovered_from_booking_id IS NULL
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.schedule_model <> 'segments_v1'
       OR v_existing.sequence_version <> 1
       OR v_existing.public_booking_request_fingerprint IS DISTINCT FROM v_request_fingerprint
       OR v_existing.public_booking_pricing_fingerprint IS DISTINCT FROM v_expected_fingerprint
       OR pg_catalog.jsonb_typeof(v_existing.public_booking_pricing_snapshot) IS DISTINCT FROM 'object'
       OR v_existing.public_booking_pricing_snapshot->>'booking_id' IS DISTINCT FROM v_existing.id::text
       OR v_existing.public_booking_pricing_snapshot->'sms_consent'
         IS DISTINCT FROM pg_catalog.to_jsonb(v_sms_consent)
       OR v_existing.public_booking_pricing_snapshot->>'notification_language'
         IS DISTINCT FROM v_notification_language
       OR coalesce(v_existing.public_booking_pricing_snapshot->>'salon_slug','')
         !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
       OR length(v_existing.public_booking_pricing_snapshot->>'salon_slug')>100
       OR v_existing.client_locale IS DISTINCT FROM v_notification_language THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'idempotency_conflict');
    END IF;
    IF (v_otp_session_id IS NULL AND v_existing.otp_session_id IS NOT NULL)
       OR (v_otp_session_id IS NOT NULL AND (
         v_existing.otp_session_id IS DISTINCT FROM v_otp_session_id
         OR v_existing.verification_method NOT IN ('otp', 'both')
         OR v_existing.verification_completed_at IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.phone_otp_sessions otp
           WHERE otp.id = v_otp_session_id
             AND otp.salon_id = v_existing.salon_id
             AND public.canonical_phone(otp.phone)
                 = public.canonical_phone(v_existing.client_phone)
             AND otp.consumed_at IS NOT NULL
             AND otp.consumed_by_booking_id = v_existing.id
         )
       )) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'idempotency_conflict');
    END IF;
    IF v_health_acknowledged AND v_existing.health_ack_at IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'idempotency_conflict');
    END IF;
    IF v_existing.status <> 'confirmed' OR v_existing.deleted_at IS NOT NULL
       OR v_existing.start_time_utc IS DISTINCT FROM
          (v_existing.public_booking_pricing_snapshot->>'parent_start_time_utc')::timestamptz
       OR v_existing.end_time_utc IS DISTINCT FROM
          (v_existing.public_booking_pricing_snapshot->>'parent_end_time_utc')::timestamptz
       OR (SELECT count(*) FROM public.booking_service_segments seg
           WHERE seg.booking_id = v_existing.id)
          <> pg_catalog.jsonb_array_length(v_existing.public_booking_pricing_snapshot->'segment_ids')
       OR EXISTS (SELECT 1 FROM public.booking_service_segments seg
           WHERE seg.booking_id=v_existing.id AND seg.reservation_status<>'confirmed')
       OR (SELECT coalesce(pg_catalog.jsonb_agg(seg.id ORDER BY seg.position), '[]'::jsonb)
           FROM public.booking_service_segments seg
           WHERE seg.booking_id = v_existing.id)
          IS DISTINCT FROM v_existing.public_booking_pricing_snapshot->'segment_ids' THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false, 'code', 'booking_state_changed',
        'booking_id', v_existing.id, 'status', v_existing.status
      );
    END IF;
    RETURN v_existing.public_booking_pricing_snapshot || pg_catalog.jsonb_build_object(
      'success', true, 'code', 'booked', 'idempotent', true,
      'pricing_snapshot', v_existing.public_booking_pricing_snapshot
    );
  END IF;

  v_quote := public.resolve_booking_sequence_pricing_and_schedule(p_request, true);
  IF coalesce(v_quote->>'success', 'false') <> 'true' THEN
    RETURN v_quote;
  END IF;
  v_quote_fingerprint := v_quote->>'pricing_fingerprint';
  v_voucher_id := nullif(v_quote->>'voucher_id', '')::uuid;
  IF v_quote_fingerprint IS DISTINCT FROM v_expected_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'pricing_changed', 'quote', v_quote
    );
  END IF;

  SELECT
    CASE
      WHEN s.plan_override IN ('free', 'pro', 'premium') THEN s.plan_override
      WHEN s.subscription_plan IN ('free', 'pro', 'premium') THEN s.subscription_plan
      ELSE 'free'
    END,
    coalesce(s.feature_flags, '{}'::jsonb),
    coalesce(s.phone_otp_enabled, false),
    CASE
      WHEN s.health_ack_required IS NOT NULL THEN s.health_ack_required
      ELSE lower(coalesce(s.vertical, 'nail_salon')) IN (
        'head_spa', 'facial', 'massage', 'waxing'
      )
    END,
    coalesce(s.noshow_protection_enabled, false),
    nullif(trim(s.payment_provider), ''),
    nullif(trim(s.slug), '')
  INTO v_effective_plan, v_feature_flags, v_phone_otp_enabled,
    v_health_ack_required, v_locked_noshow_protection_enabled,
    v_locked_payment_provider, v_salon_slug
  FROM public.salons s
  WHERE s.id = v_salon_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_reference');
  END IF;
  IF v_salon_slug IS NULL OR length(v_salon_slug)>100
     OR v_salon_slug!~'^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','pricing_config_invalid');
  END IF;
  IF v_locked_noshow_protection_enabled OR v_locked_payment_provider IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'payment_not_supported');
  END IF;
  IF v_health_ack_required AND NOT v_health_acknowledged THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'health_ack_required');
  END IF;
  IF v_effective_plan = 'free'
     AND coalesce(v_feature_flags->>'unlimited_bookings', 'false') <> 'true' THEN
    SELECT count(*) INTO v_month_count
    FROM public.bookings b
    WHERE b.salon_id = v_salon_id
      AND b.start_time_utc >= v_month_start
      AND b.start_time_utc < v_month_start + interval '1 month'
      AND b.status <> 'cancelled';
    IF v_month_count + 1 > 50 THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false, 'code', 'monthly_booking_limit_reached'
      );
    END IF;
  END IF;

  -- The route may preflight OTP for UX, but authorization and consumption
  -- happen only here under the same salon/session locks and transaction as
  -- booking persistence.  An OTP-disabled salon rejects a caller bearer so a
  -- stale/misrouted token can never be silently attached.
  IF v_phone_otp_enabled THEN
    IF v_otp_session_id IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'otp_required');
    END IF;
    SELECT otp.* INTO v_otp_session
    FROM public.phone_otp_sessions otp
    WHERE otp.id = v_otp_session_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_otp_session.salon_id IS DISTINCT FROM v_salon_id
       OR public.canonical_phone(v_otp_session.phone)
          IS DISTINCT FROM public.canonical_phone(v_digits)
       OR v_otp_session.verified_at IS NULL
       OR v_otp_session.expires_at <= transaction_timestamp() THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_otp_session');
    END IF;
    IF v_otp_session.consumed_at IS NOT NULL
       OR v_otp_session.consumed_by_booking_id IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'otp_session_used');
    END IF;
  ELSIF v_otp_session_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'otp_not_required');
  END IF;

  v_first := v_quote->'segments'->0;
  FOR v_segment IN
    SELECT value FROM pg_catalog.jsonb_array_elements(v_quote->'segments')
  LOOP
    v_service_total := v_service_total + (v_segment->>'service_price_cents')::integer;
    v_addon_total := v_addon_total + (v_segment->>'addon_price_cents')::integer;
  END LOOP;

  v_profile_id := public.resolve_client_profile(
    v_digits,
    trim(v_customer->>'name'),
    v_email,
    (v_first->>'staff_id')::uuid
  );

  BEGIN
    INSERT INTO public.bookings (
      id, salon_id, service_id, staff_id, resource_id,
      client_name, client_phone, client_email, client_notes, client_locale,
      start_time_utc, end_time_utc, status, confirmed_at,
      verification_method, verification_completed_at, otp_session_id,
      health_ack_at,
      price_cents, addon_service_id, addon_price_cents,
      promo_id, original_price_cents, subtotal_cents, tax_amount_cents,
      source, booking_channel, staff_requested_by_client,
      idempotency_key, client_profile_id,
      schedule_model, sequence_version,
      public_booking_request_fingerprint,
      public_booking_pricing_fingerprint,
      public_booking_pricing_snapshot
    ) VALUES (
      v_booking_id, v_salon_id,
      (v_first->>'service_id')::uuid,
      (v_first->>'staff_id')::uuid,
      nullif(v_first->>'resource_id', '')::uuid,
      trim(v_customer->>'name'), v_digits, v_email,
      NULL, v_notification_language,
      (v_quote->>'parent_start_time_utc')::timestamptz,
      (v_quote->>'parent_end_time_utc')::timestamptz,
      'confirmed', transaction_timestamp(),
      CASE WHEN v_phone_otp_enabled THEN 'otp' ELSE NULL END,
      CASE WHEN v_phone_otp_enabled THEN v_otp_session.verified_at ELSE NULL END,
      CASE WHEN v_phone_otp_enabled THEN v_otp_session_id ELSE NULL END,
      CASE WHEN v_health_acknowledged THEN transaction_timestamp() ELSE NULL END,
      v_service_total,
      nullif(v_first->>'first_addon_id', '')::uuid,
      CASE WHEN v_addon_total > 0 THEN v_addon_total ELSE NULL END,
      nullif(v_first->>'promo_id', '')::uuid,
      (v_quote->>'original_price_cents')::integer,
      (v_quote->>'subtotal_cents')::integer,
      (v_quote->>'tax_cents')::integer,
      'appointment', 'online',
      coalesce((p_request->>'same_staff_for_all')::boolean, false),
      v_request_id, v_profile_id,
      'segments_v1', 1,
      v_request_fingerprint, v_quote_fingerprint, v_quote
    );

    FOR v_segment IN
      SELECT value FROM pg_catalog.jsonb_array_elements(v_quote->'segments')
      ORDER BY (value->>'position')::integer
    LOOP
      INSERT INTO public.booking_service_segments (
        booking_id, salon_id, position, line_id, service_id, staff_id, resource_id,
        customer_start_utc, customer_end_utc,
        occupied_start_utc, occupied_end_utc,
        prep_minutes, service_duration_minutes,
        sequential_addon_minutes, trailing_buffer_minutes,
        service_name, staff_name, original_service_price_cents,
        service_pre_voucher_cents, addon_pre_voucher_cents,
        promo_discount_cents, email_discount_cents, voucher_discount_cents,
        service_price_cents, addon_price_cents, subtotal_cents,
        tax_cents, total_cents, promo_id, addon_lines, tax_breakdown,
        reservation_status
      ) VALUES (
        v_booking_id, v_salon_id,
        (v_segment->>'position')::smallint,
        (v_segment->>'line_id')::uuid,
        (v_segment->>'service_id')::uuid,
        (v_segment->>'staff_id')::uuid,
        nullif(v_segment->>'resource_id', '')::uuid,
        (v_segment->>'customer_start_utc')::timestamptz,
        (v_segment->>'customer_end_utc')::timestamptz,
        (v_segment->>'occupied_start_utc')::timestamptz,
        (v_segment->>'occupied_end_utc')::timestamptz,
        (v_segment->>'prep_minutes')::integer,
        (v_segment->>'service_duration_minutes')::integer,
        (v_segment->>'sequential_addon_minutes')::integer,
        (v_segment->>'trailing_buffer_minutes')::integer,
        v_segment->>'service_name', v_segment->>'staff_name',
        (v_segment->>'original_service_price_cents')::integer,
        (v_segment->>'service_pre_voucher_cents')::integer,
        (v_segment->>'addon_pre_voucher_cents')::integer,
        (v_segment->>'promo_discount_cents')::integer,
        (v_segment->>'email_discount_cents')::integer,
        (v_segment->>'voucher_discount_cents')::integer,
        (v_segment->>'service_price_cents')::integer,
        (v_segment->>'addon_price_cents')::integer,
        (v_segment->>'subtotal_cents')::integer,
        (v_segment->>'tax_cents')::integer,
        (v_segment->>'total_cents')::integer,
        nullif(v_segment->>'promo_id', '')::uuid,
        v_segment->'addon_lines', v_segment->'tax_breakdown', 'confirmed'
      ) RETURNING id INTO v_segment_id;
      v_segment_ids := pg_catalog.array_append(v_segment_ids, v_segment_id);

      v_addon_remaining := (v_segment->>'addon_price_cents')::integer;
      FOR v_addon IN
        SELECT value FROM pg_catalog.jsonb_array_elements(v_segment->'addon_lines')
      LOOP
        v_addon_persist := least((v_addon->>'price_cents')::integer, v_addon_remaining);
        v_addon_remaining := v_addon_remaining - v_addon_persist;
        INSERT INTO public.booking_addons (
          booking_id, booking_service_segment_id, service_id,
          name, price_cents, duration_minutes
        ) VALUES (
          v_booking_id, v_segment_id, (v_addon->>'service_id')::uuid,
          v_addon->>'name', v_addon_persist,
          (v_addon->>'duration_minutes')::integer
        );
      END LOOP;
      IF v_addon_remaining <> 0 THEN
        RAISE EXCEPTION 'sequence addon allocation invariant failed';
      END IF;
    END LOOP;

    IF pg_catalog.cardinality(v_segment_ids)
       <> pg_catalog.jsonb_array_length(v_quote->'segments') THEN
      RAISE EXCEPTION 'sequence segment count invariant failed';
    END IF;

    IF (v_quote->>'email_discount_cents')::integer > 0 THEN
      UPDATE public.client_profiles cp
      SET email_discount_claimed_at = transaction_timestamp(),
          updated_at = transaction_timestamp()
      WHERE cp.id = v_profile_id
        AND cp.phone = v_digits
        AND cp.email_discount_claimed_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'sequence email discount claim not persisted';
      END IF;
    END IF;

    IF v_voucher_id IS NOT NULL THEN
      INSERT INTO public.voucher_redemptions (
        voucher_id, salon_id, booking_id, client_phone,
        discount_applied_cents, original_price_cents, final_price_cents
      ) VALUES (
        v_voucher_id, v_salon_id, v_booking_id, v_digits,
        (v_quote->>'voucher_discount_cents')::integer,
        (v_quote->>'pre_voucher_subtotal_cents')::integer,
        (v_quote->>'subtotal_cents')::integer
      );
    END IF;

    IF v_phone_otp_enabled THEN
      UPDATE public.phone_otp_sessions otp
      SET consumed_at = transaction_timestamp(),
          consumed_by_booking_id = v_booking_id
      WHERE otp.id = v_otp_session_id
        AND otp.consumed_at IS NULL
        AND otp.consumed_by_booking_id IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'sequence OTP consumption invariant failed';
      END IF;
      UPDATE public.client_profiles cp
      SET phone_verified_at = CASE
            WHEN cp.phone_verified_at IS NULL
              OR cp.phone_verified_at < v_otp_session.verified_at
              THEN v_otp_session.verified_at
            ELSE cp.phone_verified_at
          END,
          updated_at = transaction_timestamp()
      WHERE cp.id = v_profile_id
        AND public.canonical_phone(cp.phone) = public.canonical_phone(v_digits);
      IF NOT FOUND THEN
        RAISE EXCEPTION 'sequence OTP profile invariant failed';
      END IF;
    END IF;

    v_snapshot := v_quote || pg_catalog.jsonb_build_object(
      'booking_id', v_booking_id,
      'segment_ids', pg_catalog.to_jsonb(v_segment_ids),
      'sms_consent',v_sms_consent,
      'notification_language',v_notification_language,
      'salon_slug',v_salon_slug,
      'reschedule_intent', pg_catalog.jsonb_build_object(
        'same_staff_for_all', coalesce((p_request->>'same_staff_for_all')::boolean, false),
        'lines', p_request->'lines'
      )
    );
    UPDATE public.bookings b
    SET public_booking_pricing_snapshot = v_snapshot
    WHERE b.id = v_booking_id;
    RETURN v_snapshot || pg_catalog.jsonb_build_object(
      'success', true, 'code', 'booked', 'idempotent', false,
      'pricing_snapshot', v_snapshot
    );
  EXCEPTION
    WHEN exclusion_violation THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'slot_conflict');
    WHEN unique_violation THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'write_conflict');
    WHEN check_violation OR foreign_key_violation THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_reference');
  END;
END;
$sequence_create$;

REVOKE ALL ON FUNCTION public.create_public_booking_sequence(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_booking_sequence(jsonb)
  TO service_role;

-- Read-only response-loss recovery. This intentionally performs no quote,
-- readiness/config/rate evaluation, catalog lookup, or write. It reconstructs
-- the exact canonical create request identity (including OTP bearer, health
-- acknowledgement, and expected pricing) and returns only a fully persisted,
-- still-confirmed receipt. The advisory key waits for an in-flight canonical
-- create transaction without mutating business state.
CREATE OR REPLACE FUNCTION public.replay_public_booking_sequence(p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sequence_create_replay$
DECLARE
  v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','');
  v_salon_id uuid;
  v_request_id uuid;
  v_expected_fingerprint text;
  v_otp_session_id uuid;
  v_health_acknowledged boolean;
  v_sms_consent boolean;
  v_notification_language text;
  v_customer jsonb;
  v_digits text;
  v_email text;
  v_voucher_code text;
  v_request_material jsonb;
  v_request_fingerprint text;
  v_existing public.bookings%ROWTYPE;
  v_receipt jsonb;
BEGIN
  IF v_role<>'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_request IS NULL OR pg_catalog.jsonb_typeof(p_request)<>'object'
     OR (p_request-ARRAY[
       'contract_version','salon_id','request_id','requested_start_time_utc',
       'lines','same_staff_for_all','voucher_code','customer',
       'apply_email_discount','expected_pricing_fingerprint','otp_session_id',
       'health_acknowledged','sms_consent','notification_language'
     ]::text[])<>'{}'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  BEGIN
    IF (p_request->>'contract_version')::integer<>1 THEN
      RETURN pg_catalog.jsonb_build_object('success',false,'code','unsupported_contract');
    END IF;
    v_salon_id:=(p_request->>'salon_id')::uuid;
    v_request_id:=(p_request->>'request_id')::uuid;
    IF p_request?'otp_session_id'
       AND p_request->'otp_session_id'<>'null'::jsonb
       AND pg_catalog.jsonb_typeof(p_request->'otp_session_id')<>'string' THEN
      RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_input');
    END IF;
    v_otp_session_id:=nullif(trim(coalesce(p_request->>'otp_session_id','')),'')::uuid;
    IF p_request?'health_acknowledged'
       AND pg_catalog.jsonb_typeof(p_request->'health_acknowledged')<>'boolean' THEN
      RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_input');
    END IF;
    v_health_acknowledged:=coalesce((p_request->>'health_acknowledged')::boolean,false);
    IF p_request?'sms_consent'
       AND pg_catalog.jsonb_typeof(p_request->'sms_consent')<>'boolean' THEN
      RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_input');
    END IF;
    v_sms_consent:=coalesce((p_request->>'sms_consent')::boolean,false);
    IF p_request?'notification_language'
       AND (pg_catalog.jsonb_typeof(p_request->'notification_language')<>'string'
         OR p_request->>'notification_language' NOT IN ('en','vi')) THEN
      RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_input');
    END IF;
    v_notification_language:=coalesce(p_request->>'notification_language','vi');
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_input');
  END;
  v_expected_fingerprint:=p_request->>'expected_pricing_fingerprint';
  IF v_salon_id IS NULL OR v_request_id IS NULL
     OR coalesce(v_expected_fingerprint,'')!~'^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'code','missing_pricing_fingerprint');
  END IF;
  v_customer:=p_request->'customer';
  IF pg_catalog.jsonb_typeof(v_customer) IS DISTINCT FROM 'object'
     OR (v_customer-ARRAY['name','phone','email']::text[])<>'{}'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  BEGIN
    v_digits:=pg_catalog.regexp_replace(coalesce(v_customer->>'phone',''),'\D','','g');
    v_email:=nullif(lower(trim(coalesce(v_customer->>'email',''))),'');
    v_voucher_code:=nullif(upper(trim(coalesce(p_request->>'voucher_code',''))),'');
    v_request_material:=pg_catalog.jsonb_build_object(
      'contract_version',1,'salon_id',v_salon_id,'request_id',v_request_id,
      'requested_start_time_utc',p_request->'requested_start_time_utc',
      'lines',p_request->'lines',
      'same_staff_for_all',coalesce((p_request->>'same_staff_for_all')::boolean,false),
      'voucher_code',v_voucher_code,
      'customer',pg_catalog.jsonb_build_object(
        'name',trim(coalesce(v_customer->>'name','')),
        'phone',v_digits,'email',v_email),
      'apply_email_discount',coalesce((p_request->>'apply_email_discount')::boolean,false),
      'health_acknowledged',v_health_acknowledged,
      'sms_consent',v_sms_consent,
      'notification_language',v_notification_language,
      'expected_pricing_fingerprint',v_expected_fingerprint
    );
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_input');
  END;
  IF v_otp_session_id IS NOT NULL THEN
    v_request_material:=v_request_material||pg_catalog.jsonb_build_object(
      'otp_session_id',v_otp_session_id);
  END IF;
  v_request_fingerprint:=pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_request_material::text,'UTF8'),'sha256'),'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'booking-sequence-idempotency:'||v_salon_id::text||':'||v_request_id::text,0));
  SELECT b.* INTO v_existing FROM public.bookings b
  WHERE b.salon_id=v_salon_id AND b.idempotency_key=v_request_id
    AND b.group_id IS NULL AND b.recovered_from_booking_id IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','replay_not_found');
  END IF;
  IF v_existing.schedule_model<>'segments_v1' OR v_existing.sequence_version<>1
     OR v_existing.public_booking_request_fingerprint IS DISTINCT FROM v_request_fingerprint
     OR v_existing.public_booking_pricing_fingerprint IS DISTINCT FROM v_expected_fingerprint
     OR pg_catalog.jsonb_typeof(v_existing.public_booking_pricing_snapshot)
       IS DISTINCT FROM 'object'
     OR v_existing.public_booking_pricing_snapshot->>'booking_id'
       IS DISTINCT FROM v_existing.id::text
     OR v_existing.public_booking_pricing_snapshot->'sms_consent'
       IS DISTINCT FROM pg_catalog.to_jsonb(v_sms_consent)
     OR v_existing.public_booking_pricing_snapshot->>'notification_language'
       IS DISTINCT FROM v_notification_language
     OR coalesce(v_existing.public_booking_pricing_snapshot->>'salon_slug','')
       !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     OR length(v_existing.public_booking_pricing_snapshot->>'salon_slug')>100
     OR v_existing.client_locale IS DISTINCT FROM v_notification_language THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','idempotency_conflict');
  END IF;
  IF (v_otp_session_id IS NULL AND v_existing.otp_session_id IS NOT NULL)
     OR (v_otp_session_id IS NOT NULL AND (
       v_existing.otp_session_id IS DISTINCT FROM v_otp_session_id
       OR v_existing.verification_method NOT IN ('otp','both')
       OR v_existing.verification_completed_at IS NULL
       OR NOT EXISTS(SELECT 1 FROM public.phone_otp_sessions otp
         WHERE otp.id=v_otp_session_id AND otp.salon_id=v_existing.salon_id
           AND public.canonical_phone(otp.phone)=public.canonical_phone(v_existing.client_phone)
           AND otp.consumed_at IS NOT NULL
           AND otp.consumed_by_booking_id=v_existing.id)
     )) OR (v_health_acknowledged AND v_existing.health_ack_at IS NULL) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','idempotency_conflict');
  END IF;
  BEGIN
    IF v_existing.status<>'confirmed' OR v_existing.deleted_at IS NOT NULL
       OR v_existing.start_time_utc IS DISTINCT FROM
         (v_existing.public_booking_pricing_snapshot->>'parent_start_time_utc')::timestamptz
       OR v_existing.end_time_utc IS DISTINCT FROM
         (v_existing.public_booking_pricing_snapshot->>'parent_end_time_utc')::timestamptz
       OR (SELECT count(*) FROM public.booking_service_segments seg
           WHERE seg.booking_id=v_existing.id)
         <>pg_catalog.jsonb_array_length(v_existing.public_booking_pricing_snapshot->'segment_ids')
       OR EXISTS(SELECT 1 FROM public.booking_service_segments seg
           WHERE seg.booking_id=v_existing.id AND seg.reservation_status<>'confirmed')
       OR (SELECT coalesce(pg_catalog.jsonb_agg(seg.id ORDER BY seg.position),'[]'::jsonb)
           FROM public.booking_service_segments seg WHERE seg.booking_id=v_existing.id)
         IS DISTINCT FROM v_existing.public_booking_pricing_snapshot->'segment_ids' THEN
      RETURN pg_catalog.jsonb_build_object(
        'success',false,'code','booking_state_changed',
        'booking_id',v_existing.id,'status',v_existing.status);
    END IF;
  EXCEPTION WHEN invalid_datetime_format OR invalid_text_representation THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'code','booking_state_changed',
      'booking_id',v_existing.id,'status',v_existing.status);
  END;
  v_receipt:=public.load_booking_sequence_receipt(v_existing.salon_id,v_existing.id);
  IF v_receipt->>'code'<>'loaded'
     OR v_receipt->>'pricing_fingerprint' IS DISTINCT FROM v_expected_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'code','booking_state_changed',
      'booking_id',v_existing.id,'status',v_existing.status);
  END IF;
  RETURN v_existing.public_booking_pricing_snapshot||pg_catalog.jsonb_build_object(
    'success',true,'code','booked','idempotent',true,
    'pricing_snapshot',v_existing.public_booking_pricing_snapshot);
END;
$sequence_create_replay$;

REVOKE ALL ON FUNCTION public.replay_public_booking_sequence(jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.replay_public_booking_sequence(jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_booking_sequence_reschedule(
  p_booking_id uuid,
  p_request_id uuid,
  p_new_start_time_utc timestamptz,
  p_lock_claims boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sequence_reschedule_resolver$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_booking public.bookings%ROWTYPE;
  v_intent jsonb;
  v_request jsonb;
  v_schedule jsonb;
  v_schedule_segments jsonb;
  v_material jsonb;
  v_fingerprint text;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_booking_id IS NULL OR p_request_id IS NULL OR p_new_start_time_utc IS NULL
     OR p_new_start_time_utc <= transaction_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_request');
  END IF;
  IF p_lock_claims THEN
    SELECT b.* INTO v_booking FROM public.bookings b
    WHERE b.id=p_booking_id FOR UPDATE;
  ELSE
    SELECT b.* INTO v_booking FROM public.bookings b WHERE b.id=p_booking_id;
  END IF;
  IF NOT FOUND OR v_booking.deleted_at IS NOT NULL
     OR v_booking.status <> 'confirmed'
     OR v_booking.schedule_model <> 'segments_v1'
     OR v_booking.sequence_version <> 1
     OR v_booking.group_id IS NOT NULL
     OR v_booking.start_time_utc <= transaction_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','booking_state_changed');
  END IF;
  v_intent:=v_booking.public_booking_pricing_snapshot->'reschedule_intent';
  IF pg_catalog.jsonb_typeof(v_intent) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_intent->'lines') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(v_intent->'lines') NOT BETWEEN 1 AND 5
     OR (SELECT count(*) FROM public.booking_service_segments seg
         WHERE seg.booking_id=v_booking.id)
        <> pg_catalog.jsonb_array_length(v_intent->'lines') THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','sequence_receipt_invalid');
  END IF;
  v_request:=pg_catalog.jsonb_build_object(
    'contract_version',1,
    'salon_id',v_booking.salon_id,
    'request_id',p_request_id,
    'requested_start_time_utc',p_new_start_time_utc,
    'lines',v_intent->'lines',
    'same_staff_for_all',coalesce((v_intent->>'same_staff_for_all')::boolean,false),
    'voucher_code',NULL,
    'apply_email_discount',false,
    'customer',pg_catalog.jsonb_build_object(
      'name',v_booking.client_name,'phone',v_booking.client_phone,'email',v_booking.client_email
    ),
    'schedule_only',true,
    'exclude_booking_id',v_booking.id
  );
  v_schedule:=public.resolve_booking_sequence_pricing_and_schedule(v_request,p_lock_claims);
  IF coalesce((v_schedule->>'success')::boolean,false) IS NOT TRUE THEN
    RETURN v_schedule;
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'line_id',line.value->'line_id','position',(line.value->>'position')::integer,
    'service_id',line.value->'service_id',
    'staff_id',line.value->'staff_id','staff_name',line.value->'staff_name',
    'resource_id',line.value->'resource_id',
    'customer_start_utc',line.value->'customer_start_utc',
    'customer_end_utc',line.value->'customer_end_utc',
    'occupied_start_utc',line.value->'occupied_start_utc',
    'occupied_end_utc',line.value->'occupied_end_utc',
    'prep_minutes',(line.value->>'prep_minutes')::integer,
    'service_duration_minutes',(line.value->>'service_duration_minutes')::integer,
    'sequential_addon_minutes',(line.value->>'sequential_addon_minutes')::integer,
    'trailing_buffer_minutes',(line.value->>'trailing_buffer_minutes')::integer
  ) ORDER BY (line.value->>'position')::integer),'[]'::jsonb)
  INTO v_schedule_segments
  FROM pg_catalog.jsonb_array_elements(v_schedule->'segments') line(value);
  v_material:=pg_catalog.jsonb_build_object(
    'contract_version',1,'schedule_model','segments_v1','sequence_version',1,
    'booking_id',v_booking.id,'salon_id',v_booking.salon_id,
    'booking_transition_version',v_booking.customer_transition_version,
    'current_sequence_fingerprint',v_booking.public_booking_pricing_fingerprint,
    'requested_start_time_utc',p_new_start_time_utc,
    'parent_start_time_utc',v_schedule->'parent_start_time_utc',
    'parent_end_time_utc',v_schedule->'parent_end_time_utc',
    'schedule_segments',v_schedule_segments,
    'timing_segments',v_schedule->'timing_segments'
  );
  v_fingerprint:=pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_material::text,'UTF8'),'sha256'),'hex');
  RETURN v_material||pg_catalog.jsonb_build_object(
    'success',true,'code','reschedule_quoted','request_id',p_request_id,
    'sequence_fingerprint',v_fingerprint,'idempotent',false
  );
END;
$sequence_reschedule_resolver$;

CREATE OR REPLACE FUNCTION public.quote_booking_sequence_reschedule(
  p_token_id uuid,
  p_request_id uuid,
  p_new_start_time_utc timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sequence_reschedule_quote$
DECLARE
  v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','');
  v_cap public.booking_management_capabilities%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
BEGIN
  IF v_role<>'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  SELECT c.* INTO v_cap FROM public.booking_management_capabilities c
  WHERE c.id=p_token_id AND c.action='reschedule';
  IF NOT FOUND OR v_cap.scope_kind<>'booking_own' OR v_cap.group_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_token');
  END IF;
  IF v_cap.consumed_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','token_consumed');
  END IF;
  IF v_cap.revoked_at IS NOT NULL OR v_cap.expires_at<=transaction_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','expired_or_revoked');
  END IF;
  SELECT b.* INTO v_booking FROM public.bookings b
  WHERE b.id=v_cap.booking_id AND b.salon_id=v_cap.salon_id AND b.deleted_at IS NULL;
  IF NOT FOUND OR v_booking.customer_transition_version<>v_cap.booking_version THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','booking_state_changed');
  END IF;
  RETURN public.resolve_booking_sequence_reschedule(
    v_booking.id,p_request_id,p_new_start_time_utc,false
  );
END;
$sequence_reschedule_quote$;

CREATE OR REPLACE FUNCTION public.reschedule_booking_sequence_with_management_capability(
  p_token_id uuid,
  p_request_id uuid,
  p_new_start_time_utc timestamptz,
  p_expected_sequence_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sequence_reschedule_apply$
DECLARE
  v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','');
  v_cap public.booking_management_capabilities%ROWTYPE;
  v_state public.booking_management_action_state%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_salon public.salons%ROWTYPE;
  v_schedule jsonb; v_line jsonb; v_new_segments jsonb; v_new_snapshot jsonb;
  v_payload jsonb; v_payload_hash text; v_result jsonb; v_result_hash text;
  v_receipt jsonb; v_activation jsonb; v_waitlist jsonb; v_cancel_preview jsonb;
  v_now timestamptz:=transaction_timestamp();
  v_old_start timestamptz; v_old_end timestamptz; v_old_staff uuid; v_old_service uuid;
  v_transition bigint; v_lock_at timestamptz; v_lock_cents integer;
  v_actor_source text:=coalesce(
    nullif(current_setting('nailiq.sequence_reschedule_actor_source',true),''),'customer');
  v_actor_user_id uuid;
  v_notify_email boolean:=coalesce(
    nullif(current_setting('nailiq.sequence_reschedule_notify_email',true),'')::boolean,true);
  v_notify_sms boolean:=coalesce(
    nullif(current_setting('nailiq.sequence_reschedule_notify_sms',true),'')::boolean,false);
BEGIN
  IF v_role<>'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_token_id IS NULL OR p_request_id IS NULL OR p_new_start_time_utc IS NULL
     OR p_expected_sequence_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_request');
  END IF;
  BEGIN
    v_actor_user_id:=nullif(
      current_setting('nailiq.sequence_reschedule_actor_user_id',true),'')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_actor_context');
  END;
  IF v_actor_source NOT IN ('customer','staff')
     OR (v_actor_source='customer' AND v_actor_user_id IS NOT NULL)
     OR (v_actor_source='staff' AND v_actor_user_id IS NULL) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_actor_context');
  END IF;
  v_payload:=pg_catalog.jsonb_build_object(
    'action','reschedule_sequence','new_start_time_utc',p_new_start_time_utc,
    'expected_sequence_fingerprint',p_expected_sequence_fingerprint,
    'actor_source',v_actor_source,'actor_user_id',v_actor_user_id,
    'notify_email',v_notify_email,'notify_sms',v_notify_sms
  );
  v_payload_hash:=pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
  SELECT c.* INTO v_cap FROM public.booking_management_capabilities c
  WHERE c.id=p_token_id;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_token'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'booking-management:'||v_cap.booking_id::text,0));
  SELECT c.* INTO v_cap FROM public.booking_management_capabilities c
  WHERE c.id=p_token_id FOR UPDATE;
  IF v_cap.action<>'reschedule' OR v_cap.scope_kind<>'booking_own'
     OR v_cap.group_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_token');
  END IF;
  IF v_cap.consumed_at IS NOT NULL THEN
    IF v_cap.request_id=p_request_id AND v_cap.payload_fingerprint=v_payload_hash THEN
      RETURN v_cap.result_json||pg_catalog.jsonb_build_object('idempotent',true);
    END IF;
    RETURN pg_catalog.jsonb_build_object('success',false,'code','idempotency_mismatch');
  END IF;
  IF v_cap.revoked_at IS NOT NULL OR v_cap.expires_at<=v_now THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','expired_or_revoked');
  END IF;
  SELECT s.* INTO v_state FROM public.booking_management_action_state s
  WHERE s.salon_id=v_cap.salon_id AND s.booking_id=v_cap.booking_id
    AND s.action='reschedule' FOR UPDATE;
  IF NOT FOUND OR v_state.epoch<>v_cap.epoch THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','stale_epoch');
  END IF;
  SELECT b.* INTO v_booking FROM public.bookings b
  WHERE b.id=v_cap.booking_id AND b.salon_id=v_cap.salon_id
    AND b.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_booking.status<>'confirmed'
     OR v_booking.schedule_model<>'segments_v1' OR v_booking.sequence_version<>1
     OR v_booking.group_id IS NOT NULL OR v_booking.start_time_utc<=v_now
     OR v_booking.customer_transition_version<>v_cap.booking_version THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','booking_state_changed');
  END IF;
  v_schedule:=public.resolve_booking_sequence_reschedule(
    v_booking.id,p_request_id,p_new_start_time_utc,true
  );
  IF coalesce((v_schedule->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_schedule; END IF;
  IF v_schedule->>'sequence_fingerprint' IS DISTINCT FROM p_expected_sequence_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'code','pricing_changed','quote',v_schedule
    );
  END IF;
  v_old_start:=v_booking.start_time_utc; v_old_end:=v_booking.end_time_utc;
  v_old_staff:=v_booking.staff_id; v_old_service:=v_booking.service_id;
  SELECT s.* INTO STRICT v_salon FROM public.salons s WHERE s.id=v_booking.salon_id;
  IF v_booking.self_cancel_fee_locked_at IS NULL
     AND coalesce(v_salon.self_cancel_fee_enabled,false)
     AND v_old_start>v_now AND v_old_start<v_now+pg_catalog.make_interval(hours=>CASE
       WHEN coalesce(v_salon.self_cancel_window_hours,0)>0
         THEN v_salon.self_cancel_window_hours ELSE 24 END) THEN
    v_lock_cents:=CASE WHEN v_salon.self_cancel_fee_percent IS NOT NULL
      AND coalesce(v_salon.noshow_fee_percent,0)>0 THEN round(
        greatest(0,coalesce(v_booking.noshow_fee_cents,0))::numeric
        *greatest(0,v_salon.self_cancel_fee_percent)::numeric
        /v_salon.noshow_fee_percent::numeric)::integer
      ELSE greatest(0,coalesce(v_booking.noshow_fee_cents,0)) END;
    IF v_lock_cents>0 THEN v_lock_at:=v_now; END IF;
  END IF;

  BEGIN
    PERFORM pg_catalog.set_config('nailiq.sequence_reschedule_booking_id',v_booking.id::text,true);
    UPDATE public.booking_service_segments seg SET reservation_status='cancelled'
    WHERE seg.booking_id=v_booking.id;
    FOR v_line IN SELECT value FROM pg_catalog.jsonb_array_elements(
      v_schedule->'schedule_segments'
    ) ORDER BY (value->>'position')::integer LOOP
      UPDATE public.booking_service_segments seg SET
        staff_id=(v_line->>'staff_id')::uuid,
        resource_id=nullif(v_line->>'resource_id','')::uuid,
        customer_start_utc=(v_line->>'customer_start_utc')::timestamptz,
        customer_end_utc=(v_line->>'customer_end_utc')::timestamptz,
        occupied_start_utc=(v_line->>'occupied_start_utc')::timestamptz,
        occupied_end_utc=(v_line->>'occupied_end_utc')::timestamptz,
        prep_minutes=(v_line->>'prep_minutes')::integer,
        service_duration_minutes=(v_line->>'service_duration_minutes')::integer,
        sequential_addon_minutes=(v_line->>'sequential_addon_minutes')::integer,
        trailing_buffer_minutes=(v_line->>'trailing_buffer_minutes')::integer,
        staff_name=v_line->>'staff_name',reservation_status='confirmed'
      WHERE seg.booking_id=v_booking.id
        AND seg.line_id=(v_line->>'line_id')::uuid
        AND seg.position=(v_line->>'position')::integer
        AND seg.service_id=(v_line->>'service_id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'sequence reschedule line mismatch'; END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM public.booking_service_segments seg
      WHERE seg.booking_id=v_booking.id AND seg.reservation_status<>'confirmed') THEN
      RAISE EXCEPTION 'sequence reschedule did not update every segment';
    END IF;
    SELECT coalesce(pg_catalog.jsonb_agg(old_line.value||pg_catalog.jsonb_build_object(
      'staff_id',new_line.value->'staff_id','resolved_staff_id',new_line.value->'staff_id',
      'staff_name',new_line.value->'staff_name',
      'resource_id',new_line.value->'resource_id','resolved_resource_id',new_line.value->'resource_id',
      'customer_start_utc',new_line.value->'customer_start_utc',
      'service_start_utc',new_line.value->'customer_start_utc',
      'customer_end_utc',new_line.value->'customer_end_utc',
      'service_end_utc',new_line.value->'customer_end_utc',
      'occupied_start_utc',new_line.value->'occupied_start_utc',
      'occupied_end_utc',new_line.value->'occupied_end_utc',
      'prep_minutes',new_line.value->'prep_minutes',
      'service_duration_minutes',new_line.value->'service_duration_minutes',
      'sequential_addon_minutes',new_line.value->'sequential_addon_minutes',
      'trailing_buffer_minutes',new_line.value->'trailing_buffer_minutes',
      'duration_minutes',(new_line.value->>'service_duration_minutes')::integer
        +(new_line.value->>'sequential_addon_minutes')::integer,
      'buffer_minutes',new_line.value->'trailing_buffer_minutes'
    ) ORDER BY (old_line.value->>'position')::integer),'[]'::jsonb)
    INTO v_new_segments
    FROM pg_catalog.jsonb_array_elements(v_booking.public_booking_pricing_snapshot->'segments') old_line(value)
    JOIN pg_catalog.jsonb_array_elements(v_schedule->'schedule_segments') new_line(value)
      ON new_line.value->>'line_id'=old_line.value->>'line_id';
    IF pg_catalog.jsonb_array_length(v_new_segments)
       <> pg_catalog.jsonb_array_length(v_schedule->'schedule_segments') THEN
      RAISE EXCEPTION 'sequence reschedule snapshot mismatch';
    END IF;
    v_new_snapshot:=v_booking.public_booking_pricing_snapshot||pg_catalog.jsonb_build_object(
      'requested_start_time_utc',p_new_start_time_utc,
      'parent_start_time_utc',v_schedule->'parent_start_time_utc',
      'parent_end_time_utc',v_schedule->'parent_end_time_utc',
      'segments',v_new_segments,'timing_segments',v_schedule->'timing_segments',
      'pricing_fingerprint',p_expected_sequence_fingerprint,
      'rescheduled_from_sequence_fingerprint',v_booking.public_booking_pricing_fingerprint
    );
    UPDATE public.bookings b SET
      service_id=(v_schedule#>>'{schedule_segments,0,service_id}')::uuid,
      staff_id=(v_schedule#>>'{schedule_segments,0,staff_id}')::uuid,
      resource_id=nullif(v_schedule#>>'{schedule_segments,0,resource_id}','')::uuid,
      rescheduled_from_time_utc=b.start_time_utc,
      start_time_utc=(v_schedule->>'parent_start_time_utc')::timestamptz,
      end_time_utc=(v_schedule->>'parent_end_time_utc')::timestamptz,
      rescheduled_at=v_now,rescheduled_by=v_actor_source,
      reminder_24h_sent_at=NULL,reminder_3h_sent_at=NULL,status='confirmed',
      customer_transition_email_requested=v_notify_email,
      customer_transition_email_not_before=CASE WHEN v_notify_email THEN v_now END,
      self_cancel_fee_locked_at=coalesce(b.self_cancel_fee_locked_at,v_lock_at),
      self_cancel_fee_locked_cents=coalesce(b.self_cancel_fee_locked_cents,v_lock_cents),
      self_cancel_fee_lock_reason=coalesce(b.self_cancel_fee_lock_reason,
        CASE WHEN v_lock_at IS NOT NULL THEN 'customer_reschedule' END),
      public_booking_pricing_fingerprint=p_expected_sequence_fingerprint,
      public_booking_pricing_snapshot=v_new_snapshot
    WHERE b.id=v_booking.id RETURNING b.* INTO v_booking;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    PERFORM pg_catalog.set_config('nailiq.sequence_reschedule_booking_id','',true);
  EXCEPTION WHEN exclusion_violation THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','slot_conflict');
  END;
  v_transition:=v_booking.customer_transition_version;
  v_activation:=CASE WHEN v_notify_email THEN
    public.activate_customer_booking_transition_email(
      v_booking.salon_id,v_booking.id,'reschedule',v_transition,v_now
    )
  ELSE pg_catalog.jsonb_build_object(
    'success',true,'code','not_requested','activated',false
  ) END;
  v_waitlist:=public.promote_waitlist_for_freed_slot(
    v_booking.salon_id,v_old_service,
    (v_old_start AT TIME ZONE coalesce(nullif(trim(v_salon.timezone),''),'America/Los_Angeles'))::date,
    v_old_staff,v_old_start,v_old_end,20
  );
  v_cancel_preview:=public.booking_management_cancel_preview(v_booking.salon_id,v_booking.id);
  v_receipt:=public.load_booking_sequence_receipt(v_booking.salon_id,v_booking.id);
  IF v_receipt->>'code'<>'loaded' THEN RAISE EXCEPTION 'sequence receipt reconciliation failed'; END IF;
  v_result:=pg_catalog.jsonb_build_object(
    'success',true,'ok',true,'code','rescheduled','action','reschedule',
    'booking_id',v_booking.id,'salon_id',v_booking.salon_id,
    'scope_kind',v_cap.scope_kind,'previous_start_time_utc',v_old_start,
    'start_time_utc',v_booking.start_time_utc,'end_time_utc',v_booking.end_time_utc,
    'status',v_booking.status,'action_epoch',v_cap.epoch,
    'actor_source',v_actor_source,'actor_user_id',v_actor_user_id,
    'customer_transition_email_requested',v_notify_email,
    'customer_transition_sms_requested',v_notify_sms,
    'customer_transition_version',v_transition,
    'sequence_fingerprint',p_expected_sequence_fingerprint,
    'sequence_receipt',v_receipt,'transition_email',v_activation,
    'cancel_preview',v_cancel_preview,
    'promoted_waitlist',CASE WHEN v_waitlist->>'code'='promoted' THEN
      pg_catalog.jsonb_build_object(
        'waitlist_entry_id',v_waitlist->>'waitlist_entry_id',
        'claim_capability_token',v_waitlist->>'claim_capability_token',
        'offer_epoch',(v_waitlist->>'offer_epoch')::bigint,
        'expires_at',v_waitlist->>'expires_at') ELSE NULL END,
    'idempotent',false
  );
  v_result_hash:=pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_result::text,'UTF8'),'sha256'),'hex');
  UPDATE public.booking_management_capabilities c SET
    consumed_at=v_now,request_id=p_request_id,payload_fingerprint=v_payload_hash,
    result_json=v_result,result_fingerprint=v_result_hash,
    revoke_reason='action_consumed',updated_at=v_now
  WHERE c.id=v_cap.id;
  UPDATE public.booking_management_action_state s SET epoch=epoch+1,updated_at=v_now
  WHERE s.salon_id=v_cap.salon_id AND s.booking_id=v_cap.booking_id
    AND s.action='reschedule';
  INSERT INTO public.booking_management_action_receipts(
    capability_id,salon_id,booking_id,group_id,action,request_id,
    action_epoch,payload_fingerprint,result_fingerprint
  ) VALUES(v_cap.id,v_cap.salon_id,v_cap.booking_id,NULL,'reschedule',p_request_id,
    v_cap.epoch,v_payload_hash,v_result_hash);
  RETURN v_result;
END;
$sequence_reschedule_apply$;

-- Desk/staff entry point. The public/customer capability function above keeps
-- its original four-argument contract and defaults to customer + email. This
-- wrapper validates the authenticated staff identity against the tenant,
-- binds actor and notification choice into the durable payload fingerprint,
-- and reuses the same atomic sequence engine. Existing action receipts make a
-- response-loss replay independent of current booking/capability state.
CREATE OR REPLACE FUNCTION public.replay_booking_sequence_reschedule_for_desk(
  p_salon_id uuid,
  p_booking_id uuid,
  p_actor_user_id uuid,
  p_notify_email boolean,
  p_notify_sms boolean,
  p_request_id uuid,
  p_new_start_time_utc timestamptz,
  p_expected_sequence_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sequence_reschedule_desk_replay$
DECLARE
  v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','');
  v_payload jsonb;
  v_payload_hash text;
  v_prior_payload text;
  v_prior_result jsonb;
BEGIN
  IF v_role<>'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_booking_id IS NULL OR p_actor_user_id IS NULL
     OR p_notify_email IS NULL OR p_notify_sms IS NULL OR p_request_id IS NULL
     OR p_new_start_time_utc IS NULL
     OR coalesce(p_expected_sequence_fingerprint,'')!~'^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_request');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.salon_members m
    WHERE m.salon_id=p_salon_id AND m.user_id=p_actor_user_id
      AND m.role IN ('owner','admin','receptionist')) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','actor_unauthorized');
  END IF;
  v_payload:=pg_catalog.jsonb_build_object(
    'action','reschedule_sequence','new_start_time_utc',p_new_start_time_utc,
    'expected_sequence_fingerprint',p_expected_sequence_fingerprint,
    'actor_source','staff','actor_user_id',p_actor_user_id,
    'notify_email',p_notify_email,'notify_sms',p_notify_sms);
  v_payload_hash:=pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'booking-management:'||p_booking_id::text,0));
  SELECT c.payload_fingerprint,c.result_json
  INTO v_prior_payload,v_prior_result
  FROM public.booking_management_action_receipts r
  JOIN public.booking_management_capabilities c ON c.id=r.capability_id
  WHERE r.salon_id=p_salon_id AND r.booking_id=p_booking_id
    AND r.action='reschedule' AND r.request_id=p_request_id
  ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','replay_not_found');
  END IF;
  IF v_prior_payload IS DISTINCT FROM v_payload_hash THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','idempotency_mismatch');
  END IF;
  RETURN v_prior_result||pg_catalog.jsonb_build_object('idempotent',true);
END;
$sequence_reschedule_desk_replay$;

CREATE OR REPLACE FUNCTION public.quote_booking_sequence_reschedule_for_desk(
  p_salon_id uuid,
  p_booking_id uuid,
  p_actor_user_id uuid,
  p_request_id uuid,
  p_new_start_time_utc timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sequence_reschedule_desk_quote$
DECLARE
  v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','');
BEGIN
  IF v_role<>'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_booking_id IS NULL OR p_actor_user_id IS NULL
     OR p_request_id IS NULL OR p_new_start_time_utc IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_request');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.salon_members m
    WHERE m.salon_id=p_salon_id AND m.user_id=p_actor_user_id
      AND m.role IN ('owner','admin','receptionist')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','actor_unauthorized');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.id=p_booking_id AND b.salon_id=p_salon_id AND b.deleted_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','booking_not_found');
  END IF;
  RETURN public.resolve_booking_sequence_reschedule(
    p_booking_id,p_request_id,p_new_start_time_utc,false
  );
END;
$sequence_reschedule_desk_quote$;

CREATE OR REPLACE FUNCTION public.reschedule_booking_sequence_for_desk(
  p_salon_id uuid,
  p_booking_id uuid,
  p_actor_user_id uuid,
  p_notify_email boolean,
  p_notify_sms boolean,
  p_request_id uuid,
  p_new_start_time_utc timestamptz,
  p_expected_sequence_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sequence_reschedule_desk_apply$
DECLARE
  v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','');
  v_payload jsonb;
  v_payload_hash text;
  v_prior_payload text;
  v_prior_result jsonb;
  v_cap jsonb;
  v_result jsonb;
BEGIN
  IF v_role<>'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_booking_id IS NULL OR p_actor_user_id IS NULL
     OR p_notify_email IS NULL OR p_notify_sms IS NULL OR p_request_id IS NULL
     OR p_new_start_time_utc IS NULL
     OR coalesce(p_expected_sequence_fingerprint,'') !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_request');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.salon_members m
    WHERE m.salon_id=p_salon_id AND m.user_id=p_actor_user_id
      AND m.role IN ('owner','admin','receptionist')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','actor_unauthorized');
  END IF;

  v_payload:=pg_catalog.jsonb_build_object(
    'action','reschedule_sequence','new_start_time_utc',p_new_start_time_utc,
    'expected_sequence_fingerprint',p_expected_sequence_fingerprint,
    'actor_source','staff','actor_user_id',p_actor_user_id,
    'notify_email',p_notify_email,'notify_sms',p_notify_sms
  );
  v_payload_hash:=pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'booking-management:'||p_booking_id::text,0));

  SELECT c.payload_fingerprint,c.result_json
  INTO v_prior_payload,v_prior_result
  FROM public.booking_management_action_receipts r
  JOIN public.booking_management_capabilities c ON c.id=r.capability_id
  WHERE r.salon_id=p_salon_id AND r.booking_id=p_booking_id
    AND r.action='reschedule' AND r.request_id=p_request_id
  ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
  IF FOUND THEN
    IF v_prior_payload IS DISTINCT FROM v_payload_hash THEN
      RETURN pg_catalog.jsonb_build_object('success',false,'code','idempotency_mismatch');
    END IF;
    RETURN v_prior_result||pg_catalog.jsonb_build_object('idempotent',true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.id=p_booking_id AND b.salon_id=p_salon_id AND b.deleted_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','booking_not_found');
  END IF;
  v_cap:=public.mint_booking_management_capability(
    p_salon_id,p_booking_id,'reschedule',transaction_timestamp()+interval '5 minutes'
  );
  IF coalesce((v_cap->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_cap||pg_catalog.jsonb_build_object('success',false);
  END IF;
  PERFORM pg_catalog.set_config(
    'nailiq.sequence_reschedule_actor_source','staff',true);
  PERFORM pg_catalog.set_config(
    'nailiq.sequence_reschedule_actor_user_id',p_actor_user_id::text,true);
  PERFORM pg_catalog.set_config(
    'nailiq.sequence_reschedule_notify_email',p_notify_email::text,true);
  PERFORM pg_catalog.set_config(
    'nailiq.sequence_reschedule_notify_sms',p_notify_sms::text,true);
  v_result:=public.reschedule_booking_sequence_with_management_capability(
    (v_cap->>'token_id')::uuid,p_request_id,p_new_start_time_utc,
    p_expected_sequence_fingerprint
  );
  PERFORM pg_catalog.set_config('nailiq.sequence_reschedule_actor_source','',true);
  PERFORM pg_catalog.set_config('nailiq.sequence_reschedule_actor_user_id','',true);
  PERFORM pg_catalog.set_config('nailiq.sequence_reschedule_notify_email','',true);
  PERFORM pg_catalog.set_config('nailiq.sequence_reschedule_notify_sms','',true);
  RETURN v_result;
END;
$sequence_reschedule_desk_apply$;

REVOKE ALL ON FUNCTION public.resolve_booking_sequence_reschedule(uuid,uuid,timestamptz,boolean),
  public.quote_booking_sequence_reschedule(uuid,uuid,timestamptz),
  public.reschedule_booking_sequence_with_management_capability(uuid,uuid,timestamptz,text),
  public.replay_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text),
  public.quote_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,uuid,timestamptz),
  public.reschedule_booking_sequence_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_booking_sequence_reschedule(uuid,uuid,timestamptz,boolean),
  public.quote_booking_sequence_reschedule(uuid,uuid,timestamptz),
  public.reschedule_booking_sequence_with_management_capability(uuid,uuid,timestamptz,text),
  public.replay_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text),
  public.quote_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,uuid,timestamptz),
  public.reschedule_booking_sequence_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.load_public_booking_sequence_readiness(
  p_salon_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO ''
AS $sequence_readiness$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_platform boolean := false;
  v_salon boolean := false;
  v_qa_allowlisted boolean := false;
  v_catalog boolean := false;
  v_capacity boolean := false;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  SELECT coalesce(p.enabled, false) INTO v_platform
  FROM public.platform_flags p WHERE p.key = 'feature_multi_service_booking';
  v_platform := coalesce(v_platform, false);
  SELECT s.feature_flags->'multi_service_booking_enabled' = 'true'::jsonb
  INTO v_salon FROM public.salons s
  WHERE s.id = p_salon_id AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'not_found');
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.platform_settings ps
    WHERE ps.id = 'platform' AND ps.multi_service_booking_qa_salon_id = p_salon_id)
  INTO v_qa_allowlisted;
  SELECT (
    count(*) FILTER (WHERE svc.deleted_at IS NULL AND svc.is_addon IS FALSE
      AND svc.price_cents >= 0 AND svc.duration_minutes > 0
      AND svc.buffer_minutes >= 0 AND svc.prep_minutes BETWEEN 0 AND 180) >= 2
    AND EXISTS (SELECT 1 FROM public.staff st
      WHERE st.salon_id = p_salon_id AND st.status = 'active' AND st.deleted_at IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM public.services required
      WHERE required.salon_id = p_salon_id AND required.deleted_at IS NULL
        AND required.is_addon IS FALSE
        AND EXISTS (SELECT 1 FROM public.staff_services configured
          JOIN public.staff configured_staff ON configured_staff.id = configured.staff_id
          WHERE configured_staff.salon_id = p_salon_id
            AND configured_staff.status = 'active' AND configured_staff.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM public.staff_services ss
          JOIN public.staff capable ON capable.id = ss.staff_id
          WHERE ss.service_id = required.id AND capable.salon_id = p_salon_id
            AND capable.status = 'active' AND capable.deleted_at IS NULL)
    )
    AND (
      NOT EXISTS (SELECT 1 FROM public.salons rs
        WHERE rs.id = p_salon_id AND rs.resources_enabled IS TRUE)
      OR EXISTS (SELECT 1 FROM public.salon_resources r
        WHERE r.salon_id = p_salon_id AND r.status = 'active' AND r.deleted_at IS NULL)
    )
  ) INTO v_catalog FROM public.services svc WHERE svc.salon_id = p_salon_id;
  SELECT count(*) = 4
    AND bool_and(c.convalidated)
    AND count(*) FILTER (WHERE c.conrelid = 'public.bookings'::regclass
      AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%schedule_model%single%') = 2
    AND count(*) FILTER (WHERE c.conrelid = 'public.booking_service_segments'::regclass) = 2
  INTO v_capacity
  FROM pg_catalog.pg_constraint c
  WHERE c.conname IN (
    'bookings_no_overlap', 'bookings_resource_no_overlap',
    'booking_service_segments_staff_no_overlap',
    'booking_service_segments_resource_no_overlap'
  ) AND c.contype = 'x'
    AND c.connamespace = 'public'::regnamespace;
  v_capacity := coalesce(v_capacity, false)
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.bookings'::regclass
        AND t.tgname = 'enforce_single_booking_capacity_across_models'
        AND NOT t.tgisinternal)
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.booking_service_segments'::regclass
        AND t.tgname = 'enforce_segment_capacity_across_models'
        AND NOT t.tgisinternal)
    AND NOT has_function_privilege('anon',
      'public.quote_public_booking_sequence(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated',
      'public.create_public_booking_sequence(jsonb)', 'EXECUTE')
    AND has_function_privilege('service_role',
      'public.create_public_booking_sequence(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon',
      'public.replay_public_booking_sequence(jsonb)', 'EXECUTE')
    AND has_function_privilege('service_role',
      'public.replay_public_booking_sequence(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon',
      'public.quote_booking_sequence_reschedule(uuid,uuid,timestamptz)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated',
      'public.reschedule_booking_sequence_with_management_capability(uuid,uuid,timestamptz,text)',
      'EXECUTE')
    AND has_function_privilege('service_role',
      'public.quote_booking_sequence_reschedule(uuid,uuid,timestamptz)', 'EXECUTE')
    AND has_function_privilege('service_role',
      'public.reschedule_booking_sequence_with_management_capability(uuid,uuid,timestamptz,text)',
      'EXECUTE')
    AND NOT has_function_privilege('anon',
      'public.reschedule_booking_sequence_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)',
      'EXECUTE')
    AND has_function_privilege('service_role',
      'public.reschedule_booking_sequence_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)',
      'EXECUTE')
    AND NOT has_function_privilege('anon',
      'public.replay_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)',
      'EXECUTE')
    AND has_function_privilege('service_role',
      'public.replay_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)',
      'EXECUTE');
  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'loaded',
    'contract_version', 1,
    'schedule_model', 'segments_v1',
    'platform_enabled', v_platform,
    'salon_enabled', coalesce(v_salon, false),
    'qa_allowlisted', coalesce(v_qa_allowlisted, false),
    'catalog_ready', coalesce(v_catalog, false),
    'capacity_contract_ready', coalesce(v_capacity, false),
    'ready', v_platform AND coalesce(v_salon, false)
      AND coalesce(v_qa_allowlisted, false)
      AND coalesce(v_catalog, false) AND coalesce(v_capacity, false)
  );
END;
$sequence_readiness$;

REVOKE ALL ON FUNCTION public.load_public_booking_sequence_readiness(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_public_booking_sequence_readiness(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.load_booking_sequence_receipt(
  p_salon_id uuid,
  p_booking_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO ''
AS $load_sequence_receipt$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_booking public.bookings%ROWTYPE;
  v_segments jsonb;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  SELECT b.* INTO v_booking FROM public.bookings b
  WHERE b.id = p_booking_id AND b.salon_id = p_salon_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'not_found');
  END IF;
  IF v_booking.schedule_model <> 'segments_v1' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'not_sequence',
      'schedule_model', v_booking.schedule_model
    );
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'segment_id', seg.id,
      'line_id', seg.line_id,
      'position', seg.position,
      'service_id', seg.service_id,
      'service_name', seg.service_name,
      'staff_name', seg.staff_name,
      'resolved_staff_id', seg.staff_id,
      'resolved_resource_id', seg.resource_id,
      'prep_minutes', seg.prep_minutes,
      'duration_minutes', seg.service_duration_minutes + seg.sequential_addon_minutes,
      'buffer_minutes', seg.trailing_buffer_minutes,
      'occupied_start_utc', seg.occupied_start_utc,
      'service_start_utc', seg.customer_start_utc,
      'service_end_utc', seg.customer_end_utc,
      'occupied_end_utc', seg.occupied_end_utc,
      'original_service_price_cents', seg.original_service_price_cents,
      'service_pre_voucher_cents', seg.service_pre_voucher_cents,
      'addon_pre_voucher_cents', seg.addon_pre_voucher_cents,
      'promo_discount_cents', seg.promo_discount_cents,
      'promo_name', (
        SELECT snap.value->>'promo_name'
        FROM pg_catalog.jsonb_array_elements(
          coalesce(v_booking.public_booking_pricing_snapshot->'segments', '[]'::jsonb)
        ) snap(value)
        WHERE snap.value->>'line_id' = seg.line_id::text
          AND (snap.value->>'position')::integer = seg.position
        LIMIT 1
      ),
      'email_discount_cents', seg.email_discount_cents,
      'voucher_discount_cents', seg.voucher_discount_cents,
      'service_price_cents', seg.service_price_cents,
      'addon_price_cents', seg.addon_price_cents,
      'pre_voucher_subtotal_cents', greatest(
        0, seg.service_pre_voucher_cents - seg.email_discount_cents
      ) + seg.addon_pre_voucher_cents,
      'subtotal_cents', seg.subtotal_cents,
      'tax_cents', seg.tax_cents,
      'total_cents', seg.total_cents,
      'promo_id', seg.promo_id,
      'addon_lines', seg.addon_lines,
      'tax_breakdown', seg.tax_breakdown,
      'reservation_status', seg.reservation_status
    ) ORDER BY seg.position
  ), '[]'::jsonb) INTO v_segments
  FROM public.booking_service_segments seg WHERE seg.booking_id = v_booking.id;
  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'loaded',
    'booking_id', v_booking.id,
    'salon_id', v_booking.salon_id,
    'status', v_booking.status,
    'schedule_model', v_booking.schedule_model,
    'sequence_version', v_booking.sequence_version,
    'pricing_fingerprint', v_booking.public_booking_pricing_fingerprint,
    'pricing_snapshot', v_booking.public_booking_pricing_snapshot,
    'segments', v_segments
  );
END;
$load_sequence_receipt$;

REVOKE ALL ON FUNCTION public.load_booking_sequence_receipt(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_booking_sequence_receipt(uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.inspect_booking_management_capability_with_sequence(
  p_token_id uuid,
  p_expected_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO ''
AS $inspect_management_with_sequence$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_inspect jsonb;
  v_receipt jsonb;
  v_salon_id uuid;
  v_booking_id uuid;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'unauthorized');
  END IF;
  v_inspect := public.inspect_booking_management_capability(
    p_token_id, p_expected_action
  );
  IF coalesce((v_inspect->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN v_inspect;
  END IF;
  BEGIN
    v_salon_id := (v_inspect#>>'{context,salon_id}')::uuid;
    v_booking_id := (v_inspect#>>'{context,booking_id}')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'inspection_contract_invalid');
  END;
  v_receipt := public.load_booking_sequence_receipt(v_salon_id, v_booking_id);
  IF v_receipt->>'code' = 'not_sequence' THEN
    v_inspect := pg_catalog.jsonb_set(
      v_inspect, '{booking,schedule_model}',
      pg_catalog.to_jsonb(coalesce(v_receipt->>'schedule_model', 'single')), true
    );
    RETURN pg_catalog.jsonb_set(
      v_inspect, '{booking,sequence_receipt}', 'null'::jsonb, true
    );
  END IF;
  IF coalesce((v_receipt->>'success')::boolean, false) IS NOT TRUE
     OR v_receipt->>'code' <> 'loaded' THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'sequence_receipt_unavailable');
  END IF;
  v_inspect := pg_catalog.jsonb_set(
    v_inspect, '{booking,schedule_model}', '"segments_v1"'::jsonb, true
  );
  RETURN pg_catalog.jsonb_set(
    v_inspect, '{booking,sequence_receipt}', v_receipt, true
  );
END;
$inspect_management_with_sequence$;

REVOKE ALL ON FUNCTION public.inspect_booking_management_capability_with_sequence(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inspect_booking_management_capability_with_sequence(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.resolve_booking_sequence_pricing_and_schedule(jsonb, boolean) IS
  'Internal service-role sequence resolver. Reuses authoritative single-line pricing, aggregates voucher/email/tax once, and optionally locks consumable claims.';
COMMENT ON FUNCTION public.quote_public_booking_sequence(jsonb) IS
  'Service-role quote for 1..5 ordered services. Input contains IDs and customer scheduling intent; caller money/duration is rejected.';
COMMENT ON FUNCTION public.create_public_booking_sequence(jsonb) IS
  'Service-role atomic sequence create. Requires request_id and expected_pricing_fingerprint in the JSON object; exact replay returns persisted IDs/snapshot.';
COMMENT ON FUNCTION public.replay_public_booking_sequence(jsonb) IS
  'Service-role read-only committed sequence recovery before mutable readiness/rate/OTP/catalog gates. Exact request identity returns the stored confirmed receipt; absence returns replay_not_found.';
COMMENT ON FUNCTION public.resolve_booking_sequence_reschedule(uuid,uuid,timestamptz,boolean) IS
  'Internal service-role schedule-only resolver for an existing confirmed segments_v1 booking. Keeps immutable price facts and excludes the current booking capacity.';
COMMENT ON FUNCTION public.quote_booking_sequence_reschedule(uuid,uuid,timestamptz) IS
  'Service-role capability-bound whole-sequence reschedule quote. Returns an immutable schedule revision fingerprint without consuming the capability.';
COMMENT ON FUNCTION public.reschedule_booking_sequence_with_management_capability(uuid,uuid,timestamptz,text) IS
  'Service-role atomic whole-sequence reschedule. Moves parent and all segments, records the transition occurrence, promotes at most one exact waiter, and returns an exact idempotent replay receipt.';
COMMENT ON FUNCTION public.quote_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,uuid,timestamptz) IS
  'Service-role desk quote after exact salon membership validation. It is read-only and returns the same authoritative sequence revision shape as the customer quote.';
COMMENT ON FUNCTION public.reschedule_booking_sequence_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text) IS
  'Service-role desk sequence reschedule with tenant-bound actor, explicit email choice, and durable response-loss replay through the shared management receipt.';
COMMENT ON FUNCTION public.replay_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text) IS
  'Service-role read-only desk response-loss recovery from the durable action receipt before current parent assignment/lifecycle checks.';

DO $sequence_acl_proof$
DECLARE
  v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.resolve_booking_sequence_pricing_and_schedule(jsonb,boolean)',
    'public.quote_public_booking_sequence(jsonb)',
    'public.create_public_booking_sequence(jsonb)'
    ,'public.replay_public_booking_sequence(jsonb)'
    ,'public.load_public_booking_sequence_readiness(uuid)'
    ,'public.load_booking_sequence_receipt(uuid,uuid)'
    ,'public.configure_multi_service_booking_qa_salon(uuid,boolean,text)'
    ,'public.inspect_booking_management_capability_with_sequence(uuid,text)'
    ,'public.resolve_booking_sequence_reschedule(uuid,uuid,timestamptz,boolean)'
    ,'public.quote_booking_sequence_reschedule(uuid,uuid,timestamptz)'
    ,'public.reschedule_booking_sequence_with_management_capability(uuid,uuid,timestamptz,text)'
    ,'public.quote_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,uuid,timestamptz)'
    ,'public.reschedule_booking_sequence_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)'
    ,'public.replay_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)'
  ] LOOP
    IF has_function_privilege('anon', v_signature, 'EXECUTE')
       OR has_function_privilege('authenticated', v_signature, 'EXECUTE')
       OR has_function_privilege('public', v_signature, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'booking sequence ACL mismatch for %', v_signature;
    END IF;
  END LOOP;
END;
$sequence_acl_proof$;

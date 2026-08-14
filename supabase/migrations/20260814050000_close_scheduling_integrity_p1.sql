-- Scheduling-integrity closeout for customer reschedule and group booking.
--
-- This migration is deliberately additive/superseding.  Existing salons keep
-- their legacy all-capable behavior until a capability row has ever been
-- configured; after that point deleting the last row must not silently reopen
-- every service to every staff member.  Group request idempotency is promoted
-- from per-booking unique keys to a durable request ledger so the whole party,
-- itemized add-ons and one voucher redemption share one transaction result.

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS staff_capability_mode text NOT NULL DEFAULT 'legacy_all';

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'salons_staff_capability_mode_check'
      AND conrelid = 'public.salons'::regclass
  ) THEN
    ALTER TABLE public.salons
      ADD CONSTRAINT salons_staff_capability_mode_check
      CHECK (staff_capability_mode IN ('legacy_all', 'whitelist'))
      NOT VALID;
  END IF;
END
$constraint$;

-- Existing configured salons enter durable whitelist mode.  Salons that have
-- never configured a pair retain the documented legacy behavior.
UPDATE public.salons s
SET staff_capability_mode = 'whitelist'
WHERE EXISTS (
  SELECT 1
  FROM public.staff_services ss
  JOIN public.staff st ON st.id = ss.staff_id
  JOIN public.services sv ON sv.id = ss.service_id
  WHERE st.salon_id = s.id
    AND sv.salon_id = s.id
);

ALTER TABLE public.salons
  VALIDATE CONSTRAINT salons_staff_capability_mode_check;

CREATE OR REPLACE FUNCTION public.enforce_staff_capability_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_salon_id uuid;
  v_mode text;
BEGIN
  SELECT st.salon_id, s.staff_capability_mode
  INTO v_salon_id, v_mode
  FROM public.staff st
  JOIN public.services sv
    ON sv.id = NEW.service_id
   AND sv.salon_id = st.salon_id
  JOIN public.salons s ON s.id = st.salon_id
  WHERE st.id = NEW.staff_id;

  IF v_salon_id IS NULL THEN
    RAISE EXCEPTION 'staff_service_tenant_mismatch' USING ERRCODE = '23503';
  END IF;

  -- Never let one direct row insertion turn legacy-all into a partial
  -- whitelist. The transactional transition RPC flips the locked salon first,
  -- seeds every legacy pair, then narrows the requested staff member.
  IF v_mode <> 'whitelist' THEN
    RAISE EXCEPTION 'capability_transition_requires_rpc' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS mark_staff_capability_configured
  ON public.staff_services;
DROP TRIGGER IF EXISTS enforce_staff_capability_write
  ON public.staff_services;
CREATE TRIGGER enforce_staff_capability_write
BEFORE INSERT OR UPDATE OF staff_id, service_id
ON public.staff_services
FOR EACH ROW EXECUTE FUNCTION public.enforce_staff_capability_write();

DROP FUNCTION IF EXISTS public.mark_staff_capability_configured();
REVOKE ALL ON FUNCTION public.enforce_staff_capability_write()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_staff_capability_write()
  TO service_role;

CREATE OR REPLACE FUNCTION public.salon_has_staff_services(p_salon_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $function$
  SELECT coalesce(s.staff_capability_mode = 'whitelist', false)
  FROM public.salons s
  WHERE s.id = p_salon_id
$function$;

REVOKE ALL ON FUNCTION public.salon_has_staff_services(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salon_has_staff_services(uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.salon_has_staff_services(uuid) IS
  'Returns the durable staff capability mode. Once configured, an empty staff_services set remains a fail-closed whitelist.';

-- Switch a salon from legacy-all to an explicit whitelist without exposing a
-- partially migrated state.  On the first edit every existing, non-deleted
-- staff/service pair is seeded before the selected staff member is narrowed;
-- otherwise configuring one technician would silently make every colleague
-- incapable.  The function is SECURITY INVOKER so RLS remains authoritative,
-- and it additionally restricts direct authenticated callers to owner/admin.
CREATE OR REPLACE FUNCTION public.set_staff_service_capabilities(
  p_salon_id uuid,
  p_staff_id uuid,
  p_service_ids uuid[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_mode text;
  v_service_ids uuid[];
BEGIN
  -- Keep the privileged service path out of the auth-schema expression. SQL
  -- boolean evaluation is not guaranteed to short-circuit, and service_role
  -- intentionally has no direct USAGE grant on the private auth schema.
  IF current_user <> 'service_role' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.salon_members sm
      WHERE sm.salon_id = p_salon_id
        AND sm.user_id = auth.uid()
        AND sm.role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION 'owner_or_admin_required' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT s.staff_capability_mode
  INTO v_mode
  FROM public.salons s
  WHERE s.id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salon_not_found' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.staff st
  WHERE st.id = p_staff_id
    AND st.salon_id = p_salon_id
    AND st.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(array_agg(DISTINCT requested.service_id), ARRAY[]::uuid[])
  INTO v_service_ids
  FROM unnest(coalesce(p_service_ids, ARRAY[]::uuid[]))
    AS requested(service_id);

  IF EXISTS (
    SELECT 1
    FROM unnest(v_service_ids) AS requested(service_id)
    LEFT JOIN public.services sv
      ON sv.id = requested.service_id
     AND sv.salon_id = p_salon_id
     AND sv.deleted_at IS NULL
    WHERE sv.id IS NULL
  ) THEN
    RAISE EXCEPTION 'service_tenant_mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_mode = 'legacy_all' THEN
    -- The row lock plus transaction make this mode change invisible until the
    -- complete legacy matrix and requested narrowing commit together.
    UPDATE public.salons
    SET staff_capability_mode = 'whitelist'
    WHERE id = p_salon_id;

    INSERT INTO public.staff_services (staff_id, service_id)
    SELECT st.id, sv.id
    FROM public.staff st
    CROSS JOIN public.services sv
    WHERE st.salon_id = p_salon_id
      AND st.deleted_at IS NULL
      AND sv.salon_id = p_salon_id
      AND sv.deleted_at IS NULL
    ON CONFLICT (staff_id, service_id) DO NOTHING;
  END IF;

  DELETE FROM public.staff_services ss
  WHERE ss.staff_id = p_staff_id;

  INSERT INTO public.staff_services (staff_id, service_id)
  SELECT p_staff_id, requested.service_id
  FROM unnest(v_service_ids) AS requested(service_id)
  ON CONFLICT (staff_id, service_id) DO NOTHING;

  -- An intentionally empty array is still a configured, fail-closed
  -- whitelist.  Do this explicitly because no insert trigger fires for it.
  UPDATE public.salons
  SET staff_capability_mode = 'whitelist'
  WHERE id = p_salon_id;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_staff_service_capabilities(uuid, uuid, uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_staff_service_capabilities(uuid, uuid, uuid[])
  TO authenticated, service_role;

COMMENT ON FUNCTION public.set_staff_service_capabilities(uuid, uuid, uuid[]) IS
  'Atomically migrates legacy-all capability to a seeded whitelist, then replaces one tenant-scoped staff member capability set.';

-- The folded baseline allowed every authenticated salon member (including a
-- receptionist) to mutate staff_services. Keep read access for booking/setup,
-- but restrict every mutation to an owner/admin membership. The application
-- guard and transactional RPC are defense in depth; RLS is authoritative for
-- direct PostgREST requests.
DROP POLICY IF EXISTS "members write staff_services"
  ON public.staff_services;
DROP POLICY IF EXISTS owner_admin_write_staff_services
  ON public.staff_services;
CREATE POLICY owner_admin_write_staff_services
ON public.staff_services
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.staff st
    JOIN public.salon_members sm ON sm.salon_id = st.salon_id
    WHERE st.id = staff_services.staff_id
      AND sm.user_id = auth.uid()
      AND sm.role IN ('owner', 'admin')
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.staff st
    JOIN public.services sv ON sv.salon_id = st.salon_id
    JOIN public.salon_members sm ON sm.salon_id = st.salon_id
    WHERE st.id = staff_services.staff_id
      AND sv.id = staff_services.service_id
      AND sm.user_id = auth.uid()
      AND sm.role IN ('owner', 'admin')
  )
);

REVOKE ALL ON TABLE public.staff_services FROM anon, authenticated;
GRANT SELECT ON TABLE public.staff_services TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.staff_services TO authenticated;

-- B.C. observes permanent UTC-07 after the final 2026 spring-forward. Some
-- managed Postgres images can briefly lag the governing IANA tzdb release, so
-- scheduling must not depend on the server image having tzdb 2026b already.
-- Eastern B.C. exceptions use their own configured city/zone and do not enter
-- this Vancouver-only compatibility path.
CREATE OR REPLACE FUNCTION public.salon_local_timestamp(
  p_instant timestamptz,
  p_timezone text
)
RETURNS timestamp
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p_timezone = 'America/Vancouver'
      AND p_instant >= timestamptz '2026-03-08 10:00:00+00'
    THEN p_instant AT TIME ZONE 'Etc/GMT+7'
    ELSE p_instant AT TIME ZONE p_timezone
  END
$function$;

REVOKE ALL ON FUNCTION public.salon_local_timestamp(timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.salon_local_timestamp(timestamptz, text)
  TO service_role;

COMMENT ON FUNCTION public.salon_local_timestamp(timestamptz, text) IS
  'Salon-local timestamp with Vancouver permanent UTC-07 compatibility after 2026-03-08; other configured IANA city/zone choices remain unchanged.';

-- Append the non-sensitive capability mode to the existing public booking
-- projection.  This lets read-side schedulers distinguish an intentionally
-- empty whitelist from a never-configured legacy salon.
CREATE OR REPLACE VIEW public.public_salon_profiles
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  id,
  slug,
  name,
  created_at,
  address,
  salon_phone,
  opening_hours,
  profile_complete,
  booking_closed_dates,
  timezone,
  subscription_plan,
  plan_override,
  feature_flags,
  brand_color,
  theme_mode,
  currency_code,
  description,
  phone_otp_enabled,
  voice_ai_enabled,
  vertical,
  public_sections_enabled,
  booking_images,
  staff_selection_enabled,
  booking_lead_minutes,
  group_together_threshold_minutes,
  reference_image_enabled,
  health_ack_required,
  email_links_enabled,
  resources_enabled,
  primary_grid_axis,
  tax_lines,
  privacy_url,
  terms_url,
  default_language,
  logo_url,
  staff_capability_mode
FROM public.salons
WHERE archived_at IS NULL;

GRANT SELECT (staff_capability_mode) ON public.salons TO anon;
REVOKE ALL ON TABLE public.public_salon_profiles
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_salon_profiles
  TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.group_booking_requests (
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  payload_sha256 text NOT NULL,
  notification_capability_sha256 bytea,
  notification_capability_expires_at timestamptz,
  state text NOT NULL DEFAULT 'processing'
    CHECK (state IN ('processing', 'completed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (salon_id, request_id),
  CHECK (length(payload_sha256) = 64),
  CHECK (
    (state = 'processing' AND result IS NULL AND completed_at IS NULL)
    OR
    (state = 'completed' AND result IS NOT NULL AND completed_at IS NOT NULL)
  )
);

-- Re-applying this superseding migration to an environment that created the
-- ledger from an earlier draft must still add the capability association.
-- The raw capability never enters the ledger: a later, service-only
-- notification boundary verifies the digest against the canonical organizer
-- booking id stored at result.booking_ids[0].
ALTER TABLE public.group_booking_requests
  ADD COLUMN IF NOT EXISTS notification_capability_sha256 bytea,
  ADD COLUMN IF NOT EXISTS notification_capability_expires_at timestamptz;

DO $capability_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'group_booking_requests_notification_capability_check'
      AND conrelid = 'public.group_booking_requests'::regclass
  ) THEN
    ALTER TABLE public.group_booking_requests
      ADD CONSTRAINT group_booking_requests_notification_capability_check
      CHECK (
        (notification_capability_sha256 IS NULL
          AND notification_capability_expires_at IS NULL)
        OR
        (octet_length(notification_capability_sha256) = 32
          AND notification_capability_expires_at IS NOT NULL)
      );
  END IF;
END
$capability_constraint$;

ALTER TABLE public.group_booking_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.group_booking_requests
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.group_booking_requests
  TO service_role;

COMMENT ON TABLE public.group_booking_requests IS
  'Durable request-scoped idempotency ledger for one atomic group booking result. Same key plus changed payload fails closed; exact retry returns the original result. An optional short-lived notification capability is stored only as SHA-256 and binds to the canonical organizer at result.booking_ids[0].';

-- A completed request may be retried after the first transaction consumed the
-- remaining monthly plan capacity.  This boolean capability reveals no booking
-- or customer data; it only lets the application defer the plan-cap decision to
-- the fingerprint-enforcing writer for an already-known request UUID.
CREATE OR REPLACE FUNCTION public.group_booking_request_completed(
  p_salon_id uuid,
  p_request_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.group_booking_requests r
    WHERE r.salon_id = p_salon_id
      AND r.request_id = p_request_id
      AND r.state = 'completed'
  )
$function$;

REVOKE ALL ON FUNCTION public.group_booking_request_completed(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_booking_request_completed(uuid, uuid)
  TO anon, service_role;

COMMENT ON FUNCTION public.group_booking_request_completed(uuid, uuid) IS
  'Non-sensitive retry gate: true only when this salon/request UUID already has a completed durable group result.';

-- OTP sessions are single-use for new writes, but an exact network retry must
-- still reach the durable request ledger after the first call consumed its OTP.
-- A consumed/expired session is accepted only alongside an already-completed
-- request for the same salon; the writer then independently proves the exact
-- payload fingerprint or returns idempotency_conflict.  It can never authorize
-- a second booking under changed data.
CREATE OR REPLACE FUNCTION public.validate_group_booking_otp_session(
  p_session_id uuid,
  p_salon_id uuid,
  p_phone text,
  p_request_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.phone_otp_sessions s
    WHERE s.id = p_session_id
      AND s.salon_id = p_salon_id
      AND s.phone = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
      AND (
        (s.consumed_at IS NULL AND s.expires_at > now())
        OR EXISTS (
          SELECT 1
          FROM public.group_booking_requests r
          WHERE r.salon_id = p_salon_id
            AND r.request_id = p_request_id
            AND r.state = 'completed'
        )
      )
  )
$function$;

REVOKE ALL ON FUNCTION public.validate_group_booking_otp_session(
  uuid, uuid, text, uuid
)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_group_booking_otp_session(
  uuid, uuid, text, uuid
)
  TO anon, service_role;

COMMENT ON FUNCTION public.validate_group_booking_otp_session(
  uuid, uuid, text, uuid
) IS
  'Validates a fresh OTP for a new group request or permits a consumed OTP only to reach an existing completed request whose payload fingerprint remains authoritative.';

CREATE OR REPLACE FUNCTION public.insert_group_bookings_unlimited(p_bookings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_group_size integer;
  v_group_id uuid;
  v_salon_id uuid;
  v_row_salon_id uuid;
  v_request_id uuid;
  v_row_request_id uuid;
  v_notification_capability uuid;
  v_row_notification_capability uuid;
  v_notification_capability_sha256 bytea;
  v_fingerprint text;
  v_existing_fingerprint text;
  v_existing_state text;
  v_existing_result jsonb;
  v_result jsonb;
  v_error_code text;
  v_resources_enabled boolean := false;
  v_capability_mode text := 'legacy_all';
  v_booking jsonb;
  v_sanitized jsonb := '[]'::jsonb;
  v_sanitized_row jsonb;
  v_staff_id uuid;
  v_service_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_expected_end timestamptz;
  v_main_duration integer;
  v_main_buffer integer;
  v_main_price integer;
  v_addon_raw jsonb;
  v_addon_ids jsonb;
  v_addon_id uuid;
  v_addon_duration integer;
  v_addon_buffer integer;
  v_addon_price integer;
  v_addon_timing text;
  v_addon_price_sum integer;
  v_block_minutes integer;
  v_first_addon_id uuid;
  v_voucher_id uuid;
  v_row_voucher_id uuid;
  v_lock_id uuid;
  v_resource_id uuid;
  v_has_active_resource boolean;
  v_inserted uuid[] := ARRAY[]::uuid[];
  v_new_id uuid;
  v_idx integer := 0;
  v_digits text;
  v_is_party boolean;
  v_profile_id uuid;
  v_total_cents integer := 0;
  v_voucher public.vouchers%rowtype;
  v_discount_cents integer;
  v_booking_channel text;
BEGIN
  IF p_bookings IS NULL OR jsonb_typeof(p_bookings) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  v_group_size := jsonb_array_length(p_bookings);
  IF v_group_size < 2 OR v_group_size > 20 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  -- Parse the request identity before any other work.  Every member of one
  -- party must carry the same key; this is the request identity, not a row key.
  FOR v_booking IN SELECT value FROM jsonb_array_elements(p_bookings)
  LOOP
    IF jsonb_typeof(v_booking) <> 'object' THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END IF;
    BEGIN
      v_row_salon_id := nullif(v_booking->>'salon_id', '')::uuid;
      v_row_request_id := nullif(v_booking->>'idempotency_key', '')::uuid;
      v_row_notification_capability :=
        nullif(v_booking->>'notification_capability', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END;

    IF v_row_salon_id IS NULL OR v_row_request_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END IF;
    IF v_salon_id IS NULL THEN
      v_salon_id := v_row_salon_id;
      v_request_id := v_row_request_id;
      v_notification_capability := v_row_notification_capability;
    ELSIF v_salon_id <> v_row_salon_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_salon');
    ELSIF v_request_id <> v_row_request_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_idempotency_key');
    ELSIF v_notification_capability IS DISTINCT FROM v_row_notification_capability THEN
      RETURN jsonb_build_object(
        'success', false, 'code', 'invalid_notification_capability'
      );
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.salons s WHERE s.id = v_salon_id) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_salon');
  END IF;

  v_fingerprint := encode(
    extensions.digest(convert_to(p_bookings::text, 'UTF8'), 'sha256'),
    'hex'
  );

  IF v_notification_capability IS NOT NULL THEN
    v_notification_capability_sha256 := extensions.digest(
      convert_to(v_notification_capability::text, 'UTF8'),
      'sha256'
    );
  END IF;

  INSERT INTO public.group_booking_requests (
    salon_id,
    request_id,
    payload_sha256,
    notification_capability_sha256,
    notification_capability_expires_at
  ) VALUES (
    v_salon_id,
    v_request_id,
    v_fingerprint,
    v_notification_capability_sha256,
    CASE WHEN v_notification_capability_sha256 IS NULL
      THEN NULL ELSE clock_timestamp() + interval '15 minutes' END
  )
  ON CONFLICT (salon_id, request_id) DO NOTHING;

  SELECT payload_sha256, state, result
  INTO v_existing_fingerprint, v_existing_state, v_existing_result
  FROM public.group_booking_requests
  WHERE salon_id = v_salon_id
    AND request_id = v_request_id
  FOR UPDATE;

  IF v_existing_fingerprint <> v_fingerprint THEN
    RETURN jsonb_build_object('success', false, 'code', 'idempotency_conflict');
  END IF;
  IF v_existing_state = 'completed' THEN
    RETURN v_existing_result || jsonb_build_object('idempotent_replay', true);
  END IF;

  -- A nested block keeps the ledger row alive while rolling back every booking,
  -- add-on and voucher write on a typed validation/conflict failure.
  BEGIN
    SELECT
      coalesce(s.resources_enabled, false),
      coalesce(s.staff_capability_mode, 'legacy_all')
    INTO v_resources_enabled, v_capability_mode
    FROM public.salons s
    WHERE s.id = v_salon_id;

    FOR v_booking IN SELECT value FROM jsonb_array_elements(p_bookings)
    LOOP
      BEGIN
        v_staff_id := nullif(v_booking->>'staff_id', '')::uuid;
        v_service_id := nullif(v_booking->>'service_id', '')::uuid;
        v_start := nullif(v_booking->>'start_time_utc', '')::timestamptz;
        v_end := nullif(v_booking->>'end_time_utc', '')::timestamptz;
        v_row_voucher_id := nullif(v_booking->>'voucher_id', '')::uuid;
        PERFORM coalesce((v_booking->>'staff_requested_by_client')::boolean, false);
        PERFORM coalesce((v_booking->>'wave_number')::smallint, 1);
        PERFORM coalesce((v_booking->>'seat_together')::boolean, false);
      EXCEPTION
        WHEN invalid_text_representation
          OR invalid_datetime_format
          OR datetime_field_overflow
          OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'invalid_booking_data' USING ERRCODE = 'P0001';
      END;

      IF v_staff_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.staff st
        WHERE st.id = v_staff_id
          AND st.salon_id = v_salon_id
          AND st.deleted_at IS NULL
          AND st.status = 'active'
      ) THEN
        RAISE EXCEPTION 'invalid_staff' USING ERRCODE = 'P0001';
      END IF;

      SELECT
        greatest(coalesce(sv.duration_minutes, 0), 0),
        greatest(coalesce(sv.buffer_minutes, 0), 0),
        sv.price_cents
      INTO v_main_duration, v_main_buffer, v_main_price
      FROM public.services sv
      WHERE sv.id = v_service_id
        AND sv.salon_id = v_salon_id
        AND sv.deleted_at IS NULL
        AND sv.is_addon IS NOT TRUE;
      IF NOT FOUND OR v_main_duration < 1 THEN
        RAISE EXCEPTION 'invalid_service' USING ERRCODE = 'P0001';
      END IF;

      IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start
         OR v_end - v_start > interval '12 hours'
         OR v_start < clock_timestamp() - interval '15 minutes'
         OR v_start > clock_timestamp() + interval '1 year' THEN
        RAISE EXCEPTION 'invalid_booking_time' USING ERRCODE = 'P0001';
      END IF;
      IF length(trim(coalesce(v_booking->>'client_name', ''))) NOT BETWEEN 1 AND 120 THEN
        RAISE EXCEPTION 'invalid_client_name' USING ERRCODE = 'P0001';
      END IF;

      v_addon_raw := coalesce(v_booking->'addon_service_ids', '[]'::jsonb);
      IF jsonb_typeof(v_addon_raw) <> 'array' THEN
        RAISE EXCEPTION 'invalid_addons' USING ERRCODE = 'P0001';
      END IF;
      -- Bound hostile payload work without treating harmless duplicates as
      -- separate add-ons. The product limit below applies after canonical
      -- de-duplication.
      IF jsonb_array_length(v_addon_raw) > 64 THEN
        RAISE EXCEPTION 'invalid_addons' USING ERRCODE = 'P0001';
      END IF;
      IF jsonb_array_length(v_addon_raw) = 0
         AND nullif(v_booking->>'addon_service_id', '') IS NOT NULL THEN
        v_addon_raw := jsonb_build_array(v_booking->>'addon_service_id');
      END IF;

      v_addon_ids := '[]'::jsonb;
      v_addon_price_sum := 0;
      v_block_minutes := v_main_duration + v_main_buffer;
      v_first_addon_id := NULL;
      FOR v_addon_id IN
        SELECT parsed.addon_id
        FROM (
          SELECT
            (item.value #>> '{}')::uuid AS addon_id,
            min(item.ordinality) AS first_position
          FROM jsonb_array_elements(v_addon_raw)
            WITH ORDINALITY AS item(value, ordinality)
          GROUP BY (item.value #>> '{}')::uuid
        ) parsed
        ORDER BY parsed.first_position
      LOOP
        SELECT
          greatest(coalesce(sv.duration_minutes, 0), 0),
          greatest(coalesce(sv.buffer_minutes, 0), 0),
          coalesce(sv.price_cents, 0),
          coalesce(sv.addon_timing, 'sequential')
        INTO v_addon_duration, v_addon_buffer, v_addon_price, v_addon_timing
        FROM public.services sv
        WHERE sv.id = v_addon_id
          AND sv.salon_id = v_salon_id
          AND sv.deleted_at IS NULL
          AND sv.is_addon IS TRUE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'invalid_addons' USING ERRCODE = 'P0001';
        END IF;

        IF v_capability_mode = 'whitelist' AND NOT EXISTS (
          SELECT 1 FROM public.staff_services ss
          WHERE ss.staff_id = v_staff_id
            AND ss.service_id = v_addon_id
        ) THEN
          RAISE EXCEPTION 'staff_incapable' USING ERRCODE = 'P0001';
        END IF;

        IF v_first_addon_id IS NULL THEN v_first_addon_id := v_addon_id; END IF;
        v_addon_ids := v_addon_ids || jsonb_build_array(v_addon_id);
        v_addon_price_sum := v_addon_price_sum + v_addon_price;
        IF v_addon_timing <> 'concurrent' THEN
          v_block_minutes := v_block_minutes + v_addon_duration + v_addon_buffer;
        END IF;
      END LOOP;

      IF jsonb_array_length(v_addon_ids) > 8 THEN
        RAISE EXCEPTION 'too_many_addons' USING ERRCODE = 'P0001';
      END IF;

      IF v_capability_mode = 'whitelist' AND NOT EXISTS (
        SELECT 1 FROM public.staff_services ss
        WHERE ss.staff_id = v_staff_id
          AND ss.service_id = v_service_id
      ) THEN
        RAISE EXCEPTION 'staff_incapable' USING ERRCODE = 'P0001';
      END IF;

      v_expected_end := v_start + make_interval(mins => v_block_minutes);
      IF abs(extract(epoch FROM (v_end - v_expected_end))) > 1 THEN
        RAISE EXCEPTION 'invalid_booking_time' USING ERRCODE = 'P0001';
      END IF;

      IF v_idx = 0 THEN
        v_voucher_id := v_row_voucher_id;
      ELSIF v_row_voucher_id IS NOT NULL THEN
        RAISE EXCEPTION 'invalid_voucher' USING ERRCODE = 'P0001';
      END IF;

      v_booking_channel := nullif(trim(coalesce(v_booking->>'booking_channel', '')), '');
      IF v_booking_channel IS NOT NULL
         AND v_booking_channel NOT IN ('online', 'voice', 'desk') THEN
        RAISE EXCEPTION 'invalid_booking_channel' USING ERRCODE = 'P0001';
      END IF;

      v_sanitized_row :=
        (v_booking
          - 'price_cents'
          - 'addon_service_id'
          - 'addon_service_ids'
          - 'addon_price_cents'
          - 'voucher_id')
        || jsonb_build_object(
          'price_cents', v_main_price,
          'addon_service_id', v_first_addon_id,
          'addon_service_ids', v_addon_ids,
          'addon_price_cents', CASE
            WHEN jsonb_array_length(v_addon_ids) = 0 THEN NULL
            ELSE v_addon_price_sum
          END,
          'end_time_utc', v_expected_end
        );
      v_sanitized := v_sanitized || jsonb_build_array(v_sanitized_row);
      v_total_cents := v_total_cents + coalesce(v_main_price, 0) + v_addon_price_sum;
      v_idx := v_idx + 1;
    END LOOP;

    v_group_id := gen_random_uuid();

    FOR v_lock_id IN
      SELECT DISTINCT (entry.value->>'staff_id')::uuid
      FROM jsonb_array_elements(v_sanitized) AS entry(value)
      ORDER BY 1
    LOOP
      PERFORM pg_advisory_xact_lock(
        hashtext(v_salon_id::text || chr(255) || v_lock_id::text)::bigint
      );
    END LOOP;

    v_has_active_resource := false;
    IF v_resources_enabled THEN
      FOR v_lock_id IN
        SELECT r.id
        FROM public.salon_resources r
        WHERE r.salon_id = v_salon_id
          AND r.status = 'active'
          AND r.deleted_at IS NULL
        ORDER BY r.id
      LOOP
        v_has_active_resource := true;
        PERFORM pg_advisory_xact_lock(
          hashtext(v_salon_id::text || chr(254) || v_lock_id::text)::bigint
        );
      END LOOP;
      IF NOT v_has_active_resource THEN
        RAISE EXCEPTION 'slot_conflict' USING ERRCODE = 'P0001';
      END IF;
    END IF;

    v_idx := 0;
    FOR v_booking IN SELECT value FROM jsonb_array_elements(v_sanitized)
    LOOP
      v_start := (v_booking->>'start_time_utc')::timestamptz;
      v_end := (v_booking->>'end_time_utc')::timestamptz;
      v_staff_id := (v_booking->>'staff_id')::uuid;
      v_service_id := (v_booking->>'service_id')::uuid;
      v_resource_id := NULL;

      IF EXISTS (
        SELECT 1 FROM public.bookings b
        WHERE b.salon_id = v_salon_id
          AND b.staff_id = v_staff_id
          AND b.deleted_at IS NULL
          AND b.status NOT IN ('cancelled', 'no_show', 'completed')
          AND b.start_time_utc < v_end
          AND b.end_time_utc > v_start
      ) THEN
        RAISE EXCEPTION 'slot_conflict' USING ERRCODE = 'P0001';
      END IF;

      IF v_resources_enabled THEN
        SELECT r.id
        INTO v_resource_id
        FROM public.salon_resources r
        WHERE r.salon_id = v_salon_id
          AND r.status = 'active'
          AND r.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.bookings b
            WHERE b.salon_id = v_salon_id
              AND b.resource_id = r.id
              AND b.deleted_at IS NULL
              AND b.status NOT IN ('cancelled', 'no_show')
              AND b.start_time_utc < v_end
              AND b.end_time_utc > v_start
          )
        ORDER BY r.display_order ASC NULLS LAST, r.id
        LIMIT 1;
        IF v_resource_id IS NULL THEN
          RAISE EXCEPTION 'slot_conflict' USING ERRCODE = 'P0001';
        END IF;
      END IF;

      v_digits := regexp_replace(
        coalesce(public.canonical_phone(v_booking->>'client_phone'), ''),
        '\D', '', 'g'
      );
      v_is_party := length(v_digits) < 7;

      INSERT INTO public.bookings (
        salon_id, staff_id, service_id, resource_id, client_name, client_phone,
        client_email, client_notes, start_time_utc, end_time_utc, status,
        price_cents, addon_service_id, addon_price_cents,
        staff_requested_by_client, group_id, group_size, wave_number,
        seat_together, idempotency_key, client_locale, is_party_member,
        is_group_organizer, source, booking_channel
      ) VALUES (
        v_salon_id,
        v_staff_id,
        v_service_id,
        v_resource_id,
        trim(v_booking->>'client_name'),
        CASE WHEN v_is_party THEN NULL ELSE v_digits END,
        nullif(trim(coalesce(v_booking->>'client_email', '')), ''),
        nullif(trim(coalesce(v_booking->>'client_notes', '')), ''),
        v_start,
        v_end,
        'confirmed',
        CASE WHEN v_booking->>'price_cents' IS NULL THEN NULL
          ELSE (v_booking->>'price_cents')::integer END,
        nullif(v_booking->>'addon_service_id', '')::uuid,
        CASE WHEN v_booking->>'addon_price_cents' IS NULL THEN NULL
          ELSE (v_booking->>'addon_price_cents')::integer END,
        coalesce((v_booking->>'staff_requested_by_client')::boolean, false),
        v_group_id,
        v_group_size,
        coalesce((v_booking->>'wave_number')::smallint, 1),
        coalesce((v_booking->>'seat_together')::boolean, false),
        v_request_id,
        nullif(trim(coalesce(v_booking->>'client_locale', '')), ''),
        v_is_party,
        v_idx = 0,
        CASE WHEN v_booking->>'booking_channel' = 'voice' THEN 'voice' ELSE 'appointment' END,
        nullif(v_booking->>'booking_channel', '')
      ) RETURNING id INTO v_new_id;
      v_inserted := array_append(v_inserted, v_new_id);

      INSERT INTO public.booking_addons (
        booking_id, service_id, name, price_cents, duration_minutes
      )
      SELECT
        v_new_id,
        sv.id,
        sv.name,
        sv.price_cents,
        greatest(coalesce(sv.duration_minutes, 0), 0)
          + greatest(coalesce(sv.buffer_minutes, 0), 0)
      FROM jsonb_array_elements_text(v_booking->'addon_service_ids')
        WITH ORDINALITY requested(addon_id, position)
      JOIN public.services sv
        ON sv.id = requested.addon_id::uuid
       AND sv.salon_id = v_salon_id
       AND sv.deleted_at IS NULL
       AND sv.is_addon IS TRUE
      ORDER BY requested.position;

      IF NOT v_is_party THEN
        v_profile_id := public.resolve_client_profile(
          v_digits,
          v_booking->>'client_name',
          v_booking->>'client_email',
          v_staff_id
        );
        IF v_profile_id IS NOT NULL THEN
          UPDATE public.bookings
          SET client_profile_id = v_profile_id
          WHERE id = v_new_id AND salon_id = v_salon_id;
        END IF;
      END IF;
      v_idx := v_idx + 1;
    END LOOP;

    IF v_voucher_id IS NOT NULL THEN
      SELECT * INTO v_voucher
      FROM public.vouchers v
      WHERE v.id = v_voucher_id
      FOR UPDATE;

      v_digits := regexp_replace(
        coalesce(public.canonical_phone(p_bookings->0->>'client_phone'), ''),
        '\D', '', 'g'
      );
      IF NOT FOUND
         OR v_voucher.salon_id <> v_salon_id
         OR v_voucher.revoked_at IS NOT NULL
         OR v_voucher.valid_from > clock_timestamp()
         OR v_voucher.expires_at < clock_timestamp()
         OR v_voucher.used_count >= v_voucher.max_uses
         OR v_total_cents < coalesce(v_voucher.min_spend_cents, 0)
         OR (
           v_voucher.client_phone IS NOT NULL
           AND regexp_replace(
             coalesce(public.canonical_phone(v_voucher.client_phone), ''),
             '\D', '', 'g'
           ) <> v_digits
         ) THEN
        RAISE EXCEPTION 'invalid_voucher' USING ERRCODE = 'P0001';
      END IF;

      IF v_voucher.applicable_service_ids IS NOT NULL
         AND cardinality(v_voucher.applicable_service_ids) > 0
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_sanitized) entry
           WHERE (entry->>'service_id')::uuid = ANY(v_voucher.applicable_service_ids)
         ) THEN
        RAISE EXCEPTION 'invalid_voucher' USING ERRCODE = 'P0001';
      END IF;

      IF v_voucher.applicable_service_category IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(v_sanitized) entry
           JOIN public.services sv ON sv.id = (entry->>'service_id')::uuid
           WHERE sv.salon_id = v_salon_id
             AND sv.category = v_voucher.applicable_service_category
         ) THEN
        RAISE EXCEPTION 'invalid_voucher' USING ERRCODE = 'P0001';
      END IF;

      IF v_voucher.percent_off IS NOT NULL THEN
        v_discount_cents := floor(
          v_total_cents::numeric * v_voucher.percent_off::numeric / 100
        )::integer;
      ELSIF v_voucher.amount_off_cents IS NOT NULL THEN
        v_discount_cents := least(v_total_cents, v_voucher.amount_off_cents);
      ELSIF v_voucher.free_service_id IS NOT NULL THEN
        SELECT coalesce(max((entry->>'price_cents')::integer), 0)
        INTO v_discount_cents
        FROM jsonb_array_elements(v_sanitized) entry
        WHERE (entry->>'service_id')::uuid = v_voucher.free_service_id;
      ELSE
        v_discount_cents := 0;
      END IF;
      IF coalesce(v_discount_cents, 0) <= 0 THEN
        RAISE EXCEPTION 'invalid_voucher' USING ERRCODE = 'P0001';
      END IF;
      v_discount_cents := least(v_total_cents, v_discount_cents);

      INSERT INTO public.voucher_redemptions (
        voucher_id, salon_id, booking_id, client_phone,
        discount_applied_cents, original_price_cents, final_price_cents
      ) VALUES (
        v_voucher_id, v_salon_id, v_inserted[1], v_digits,
        v_discount_cents, v_total_cents, v_total_cents - v_discount_cents
      );
    END IF;

    v_result := jsonb_build_object(
      'success', true,
      'group_id', v_group_id,
      'booking_ids', to_jsonb(v_inserted),
      'voucher_discount_cents', coalesce(v_discount_cents, 0)
    );
  EXCEPTION
    WHEN exclusion_violation THEN
      v_result := jsonb_build_object('success', false, 'code', 'slot_conflict');
    WHEN unique_violation THEN
      v_result := jsonb_build_object('success', false, 'code', 'duplicate_submission');
    WHEN invalid_text_representation
      OR invalid_datetime_format
      OR datetime_field_overflow
      OR numeric_value_out_of_range THEN
      v_result := jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    WHEN SQLSTATE 'P0001' THEN
      GET STACKED DIAGNOSTICS v_error_code = MESSAGE_TEXT;
      v_result := jsonb_build_object('success', false, 'code', v_error_code);
  END;

  UPDATE public.group_booking_requests
  SET state = 'completed',
      result = v_result,
      completed_at = clock_timestamp()
  WHERE salon_id = v_salon_id
    AND request_id = v_request_id;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.insert_group_bookings_unlimited(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_group_bookings_unlimited(jsonb)
  TO service_role;

COMMENT ON FUNCTION public.insert_group_bookings_unlimited(jsonb) IS
  'Private atomic group boundary: durable request idempotency, tenant/capability validation, resource locking, canonical base/add-on snapshots, itemization and one voucher redemption.';

-- Public normal-hours boundary.  This intentionally repeats the externally
-- visible policy checks before crossing into the private atomic writer.  The
-- private function repeats tenant/capability/catalog checks as the final write
-- boundary; this wrapper additionally owns opening-hours and abuse policy.
DROP FUNCTION IF EXISTS public.insert_group_bookings(jsonb);
CREATE OR REPLACE FUNCTION public.insert_group_bookings(
  p_bookings jsonb,
  p_otp_session_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_size integer;
  v_booking jsonb;
  v_sanitized jsonb := '[]'::jsonb;
  v_salon_id uuid;
  v_row_salon_id uuid;
  v_request_id uuid;
  v_row_request_id uuid;
  v_fingerprint text;
  v_existing_fingerprint text;
  v_existing_state text;
  v_existing_result jsonb;
  v_staff_id uuid;
  v_service_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_expected_end timestamptz;
  v_main_duration integer;
  v_main_buffer integer;
  v_main_price integer;
  v_block_minutes integer;
  v_trailing_buffer integer;
  v_addon_raw jsonb;
  v_addon_ids jsonb;
  v_addon_id uuid;
  v_addon_duration integer;
  v_addon_buffer integer;
  v_addon_timing text;
  v_hours jsonb;
  v_closed_dates jsonb;
  v_timezone text;
  v_capability_mode text;
  v_phone_otp_enabled boolean;
  v_otp_session public.phone_otp_sessions%rowtype;
  v_result jsonb;
  v_finalize_result jsonb;
  v_local_start timestamp;
  v_local_completion timestamp;
  v_local_end timestamp;
  v_day text;
  v_day_config jsonb;
  v_date_ymd text;
  v_open time;
  v_close time;
  v_digits text;
  v_phone_bucket text;
BEGIN
  IF p_bookings IS NULL OR jsonb_typeof(p_bookings) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;
  v_size := jsonb_array_length(p_bookings);
  IF v_size < 2 OR v_size > 20 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  FOR v_booking IN SELECT value FROM jsonb_array_elements(p_bookings)
  LOOP
    BEGIN
      v_row_salon_id := nullif(v_booking->>'salon_id', '')::uuid;
      v_row_request_id := nullif(v_booking->>'idempotency_key', '')::uuid;
      v_staff_id := nullif(v_booking->>'staff_id', '')::uuid;
      v_service_id := nullif(v_booking->>'service_id', '')::uuid;
      v_start := nullif(v_booking->>'start_time_utc', '')::timestamptz;
      v_end := nullif(v_booking->>'end_time_utc', '')::timestamptz;
    EXCEPTION
      WHEN invalid_text_representation
        OR invalid_datetime_format
        OR datetime_field_overflow THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END;

    IF v_salon_id IS NULL THEN
      v_salon_id := v_row_salon_id;
      SELECT
        s.opening_hours,
        coalesce(s.booking_closed_dates, '[]'::jsonb),
        nullif(trim(s.timezone), ''),
        coalesce(s.staff_capability_mode, 'legacy_all'),
        coalesce(s.phone_otp_enabled, false)
      INTO v_hours, v_closed_dates, v_timezone, v_capability_mode,
        v_phone_otp_enabled
      FROM public.salons s
      WHERE s.id = v_salon_id;
      IF NOT FOUND
         OR v_hours IS NULL
         OR v_timezone IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_timezone_names n
           WHERE n.name = v_timezone
         ) THEN
        RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
      END IF;
    END IF;

    IF v_row_salon_id IS NULL OR v_row_salon_id <> v_salon_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_salon');
    END IF;
    IF v_row_request_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_idempotency_key');
    END IF;
    IF v_request_id IS NULL THEN
      v_request_id := v_row_request_id;
    ELSIF v_row_request_id <> v_request_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_idempotency_key');
    END IF;
    IF v_staff_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.staff st
      WHERE st.id = v_staff_id
        AND st.salon_id = v_salon_id
        AND st.deleted_at IS NULL
        AND st.status = 'active'
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_staff');
    END IF;

    SELECT
      greatest(coalesce(sv.duration_minutes, 0), 0),
      greatest(coalesce(sv.buffer_minutes, 0), 0),
      sv.price_cents
    INTO v_main_duration, v_main_buffer, v_main_price
    FROM public.services sv
    WHERE sv.id = v_service_id
      AND sv.salon_id = v_salon_id
      AND sv.deleted_at IS NULL
      AND sv.is_addon IS NOT TRUE;
    IF NOT FOUND OR v_main_duration < 1 THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_service');
    END IF;
    IF v_capability_mode = 'whitelist' AND NOT EXISTS (
      SELECT 1 FROM public.staff_services ss
      WHERE ss.staff_id = v_staff_id AND ss.service_id = v_service_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'staff_incapable');
    END IF;

    v_addon_raw := coalesce(v_booking->'addon_service_ids', '[]'::jsonb);
    IF jsonb_typeof(v_addon_raw) <> 'array' THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_addons');
    END IF;
    IF jsonb_array_length(v_addon_raw) > 64 THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_addons');
    END IF;
    IF jsonb_array_length(v_addon_raw) = 0
       AND nullif(v_booking->>'addon_service_id', '') IS NOT NULL THEN
      v_addon_raw := jsonb_build_array(v_booking->>'addon_service_id');
    END IF;
    BEGIN
      SELECT coalesce(jsonb_agg(to_jsonb(d.addon_id) ORDER BY d.first_position), '[]'::jsonb)
      INTO v_addon_ids
      FROM (
        SELECT
          (item.value #>> '{}')::uuid AS addon_id,
          min(item.ordinality) AS first_position
        FROM jsonb_array_elements(v_addon_raw)
          WITH ORDINALITY AS item(value, ordinality)
        GROUP BY (item.value #>> '{}')::uuid
      ) d;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_addons');
    END;
    IF jsonb_array_length(v_addon_ids) > 8 THEN
      RETURN jsonb_build_object('success', false, 'code', 'too_many_addons');
    END IF;

    v_block_minutes := v_main_duration + v_main_buffer;
    v_trailing_buffer := v_main_buffer;
    FOR v_addon_id IN
      SELECT value::uuid FROM jsonb_array_elements_text(v_addon_ids)
    LOOP
      SELECT
        greatest(coalesce(sv.duration_minutes, 0), 0),
        greatest(coalesce(sv.buffer_minutes, 0), 0),
        coalesce(sv.addon_timing, 'sequential')
      INTO v_addon_duration, v_addon_buffer, v_addon_timing
      FROM public.services sv
      WHERE sv.id = v_addon_id
        AND sv.salon_id = v_salon_id
        AND sv.deleted_at IS NULL
        AND sv.is_addon IS TRUE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_addons');
      END IF;
      IF v_capability_mode = 'whitelist' AND NOT EXISTS (
        SELECT 1 FROM public.staff_services ss
        WHERE ss.staff_id = v_staff_id AND ss.service_id = v_addon_id
      ) THEN
        RETURN jsonb_build_object('success', false, 'code', 'staff_incapable');
      END IF;
      IF v_addon_timing <> 'concurrent' THEN
        v_block_minutes := v_block_minutes + v_addon_duration + v_addon_buffer;
        v_trailing_buffer := v_addon_buffer;
      END IF;
    END LOOP;

    v_expected_end := v_start + make_interval(mins => v_block_minutes);
    IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start
       OR abs(extract(epoch FROM (v_end - v_expected_end))) > 1
       OR v_start < clock_timestamp() - interval '15 minutes'
       OR v_start > clock_timestamp() + interval '1 year' THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_time');
    END IF;

    v_local_start := public.salon_local_timestamp(v_start, v_timezone);
    v_local_end := public.salon_local_timestamp(v_expected_end, v_timezone);
    v_local_completion :=
      public.salon_local_timestamp(
        v_start + make_interval(mins => v_block_minutes - v_trailing_buffer),
        v_timezone
      );
    IF v_local_start::date <> v_local_end::date
       OR v_local_start::date <> v_local_completion::date THEN
      RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
    END IF;
    v_date_ymd := to_char(v_local_start, 'YYYY-MM-DD');
    IF jsonb_typeof(v_closed_dates) = 'array' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_closed_dates) d(value)
      WHERE d.value = v_date_ymd
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
    END IF;
    v_day := lower(to_char(v_local_start, 'Dy'));
    v_day_config := v_hours -> v_day;
    IF jsonb_typeof(v_day_config) <> 'object'
       OR coalesce((v_day_config->>'closed')::boolean, false)
       OR nullif(trim(v_day_config->>'open'), '') IS NULL
       OR nullif(trim(v_day_config->>'close'), '') IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
    END IF;
    BEGIN
      v_open := (v_day_config->>'open')::time;
      v_close := (v_day_config->>'close')::time;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
    END;
    IF v_close <= v_open
       OR v_local_start::time < v_open
       OR v_local_start::time >= v_close
       OR v_local_completion::time > v_close
       OR (
         -- A fall-back service can finish at an earlier-looking wall time
         -- even though its elapsed UTC duration is positive.  Validate every
         -- occupied service minute against the wall-clock policy instead of
         -- rejecting that legitimate DST fold.
         v_local_completion <= v_local_start
         AND EXISTS (
           SELECT 1
           FROM pg_catalog.generate_series(
             v_start,
             v_start
               + make_interval(mins => v_block_minutes - v_trailing_buffer)
               - interval '1 second',
             interval '1 minute'
           ) AS sample(instant)
           WHERE public.salon_local_timestamp(sample.instant, v_timezone)::date
                   <> v_local_start::date
              OR public.salon_local_timestamp(sample.instant, v_timezone)::time < v_open
              OR public.salon_local_timestamp(sample.instant, v_timezone)::time >= v_close
         )
       ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
    END IF;

    v_sanitized := v_sanitized || jsonb_build_array(
      (v_booking - 'price_cents' - 'addon_price_cents' - 'addon_service_id' - 'addon_service_ids')
      || jsonb_build_object(
        'price_cents', v_main_price,
        'addon_service_ids', v_addon_ids,
        'end_time_utc', v_expected_end
      )
    );
  END LOOP;

  -- Completed exact replays bypass abuse counters.  This is a read-only fast
  -- path over the same canonical payload passed to the private writer, so a
  -- changed payload under the key still fails closed and no new booking can be
  -- created without passing the normal limits below.
  v_fingerprint := encode(
    extensions.digest(convert_to(v_sanitized::text, 'UTF8'), 'sha256'),
    'hex'
  );
  SELECT r.payload_sha256, r.state, r.result
  INTO v_existing_fingerprint, v_existing_state, v_existing_result
  FROM public.group_booking_requests r
  WHERE r.salon_id = v_salon_id
    AND r.request_id = v_request_id;
  IF FOUND THEN
    IF v_existing_fingerprint <> v_fingerprint THEN
      RETURN jsonb_build_object('success', false, 'code', 'idempotency_conflict');
    END IF;
    IF v_existing_state = 'completed' THEN
      RETURN v_existing_result || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  IF v_role = 'anon' THEN
    IF NOT public.rate_limit_hit(
      'public-group-booking:salon:' || v_salon_id::text, 10, 600
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;
    v_digits := regexp_replace(coalesce(p_bookings->0->>'client_phone', ''), '\D', '', 'g');
    v_phone_bucket := md5(v_salon_id::text || ':' || v_digits);
    IF NOT public.rate_limit_hit(
      'public-group-booking:phone:' || v_phone_bucket, 3, 900
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;

    -- Lock the single-use proof in the same transaction that creates every
    -- group member. Concurrent request IDs cannot reuse one OTP, and a failure
    -- anywhere below rolls back bookings, ledger, profile evidence and consume.
    IF v_phone_otp_enabled THEN
      IF p_otp_session_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'otp_required');
      END IF;
      SELECT s.*
      INTO v_otp_session
      FROM public.phone_otp_sessions s
      WHERE s.id = p_otp_session_id
        AND s.salon_id = v_salon_id
        AND public.canonical_phone(s.phone) = public.canonical_phone(v_digits)
        AND s.consumed_at IS NULL
        AND s.expires_at > clock_timestamp()
      FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'otp_invalid');
      END IF;
    END IF;
  END IF;

  v_result := public.insert_group_bookings_unlimited(v_sanitized);

  IF v_role = 'anon'
     AND v_phone_otp_enabled
     AND coalesce((v_result->>'success')::boolean, false)
     AND coalesce((v_result->>'idempotent_replay')::boolean, false) IS NOT TRUE
  THEN
    v_finalize_result := public.finalize_public_booking_profile(
      (v_result->'booking_ids'->>0)::uuid,
      p_otp_session_id,
      false
    );
    IF coalesce((v_finalize_result->>'success')::boolean, false) IS NOT TRUE THEN
      -- Do not return a success whose verification proof was not committed.
      -- Raising aborts the outer transaction, including the private writer.
      RAISE EXCEPTION 'group_otp_finalize_failed' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.insert_group_bookings(jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_group_bookings(jsonb, uuid)
  TO anon, service_role;

COMMENT ON FUNCTION public.insert_group_bookings(jsonb, uuid) IS
  'Public normal-hours group boundary with tenant capability, canonical add-on timing, opening/closed-date policy, request idempotency, atomic OTP consumption and abuse limits.';

-- Durable correlation for the exact waitlist row promoted by a customer
-- reschedule.  A token is single-use, so this key is unique and avoids a
-- race-prone "latest notified for service/date" re-query after commit.
ALTER TABLE public.booking_waitlist_entries
  ADD COLUMN IF NOT EXISTS promotion_request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS booking_waitlist_promotion_request_uidx
  ON public.booking_waitlist_entries (promotion_request_id)
  WHERE promotion_request_id IS NOT NULL;
COMMENT ON COLUMN public.booking_waitlist_entries.promotion_request_id IS
  'Exact single-use scheduling request that promoted this row; used for idempotent, concurrency-safe delivery lookup.';

-- Owner/Admin after-hours boundary.  Authorization and explicit staff consent
-- stay server-only.  The private writer remains the one atomic booking,
-- add-on and voucher transaction; this wrapper only records the approved
-- exception before committing the same outer transaction.
CREATE OR REPLACE FUNCTION public.insert_controlled_after_hours_group_bookings(
  p_bookings jsonb,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_result jsonb;
  v_salon_id uuid;
  v_row jsonb;
  v_row_salon_id uuid;
  v_staff_id uuid;
  v_after_hours integer;
  v_has_after_hours boolean := false;
BEGIN
  IF p_bookings IS NULL OR jsonb_typeof(p_bookings) <> 'array'
     OR jsonb_array_length(p_bookings) < 2
     OR jsonb_array_length(p_bookings) > 20
     OR p_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_bookings)
  LOOP
    BEGIN
      v_row_salon_id := nullif(v_row->>'salon_id', '')::uuid;
      v_staff_id := nullif(v_row->>'staff_id', '')::uuid;
      v_after_hours := nullif(v_row->>'after_hours_minutes', '')::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END;
    IF v_salon_id IS NULL THEN v_salon_id := v_row_salon_id; END IF;
    IF v_row_salon_id IS NULL OR v_row_salon_id <> v_salon_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_salon');
    END IF;
    IF v_staff_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.staff st
      WHERE st.id = v_staff_id
        AND st.salon_id = v_salon_id
        AND st.status = 'active'
        AND st.deleted_at IS NULL
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_staff');
    END IF;
    IF v_after_hours IS NOT NULL THEN
      IF v_after_hours < 1 OR v_after_hours > 120 THEN
        RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
      END IF;
      v_has_after_hours := true;
    END IF;
  END LOOP;

  IF NOT v_has_after_hours THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_after_hours_override');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.salon_members sm
    WHERE sm.salon_id = v_salon_id
      AND sm.user_id = p_actor_user_id
      AND sm.role IN ('owner', 'admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  v_result := public.insert_group_bookings_unlimited(p_bookings);
  IF coalesce((v_result->>'success')::boolean, false) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  WITH booking_ids AS (
    SELECT (value #>> '{}')::uuid AS booking_id, ordinality
    FROM jsonb_array_elements(v_result->'booking_ids') WITH ORDINALITY
  ), payload_rows AS (
    SELECT value AS payload, ordinality
    FROM jsonb_array_elements(p_bookings) WITH ORDINALITY
  )
  UPDATE public.bookings b
  SET after_hours_minutes = (p.payload->>'after_hours_minutes')::smallint,
      after_hours_approved_by = p_actor_user_id,
      after_hours_staff_consent = true
  FROM booking_ids i
  JOIN payload_rows p USING (ordinality)
  WHERE b.id = i.booking_id
    AND b.salon_id = v_salon_id
    AND p.payload->>'after_hours_minutes' IS NOT NULL;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.insert_controlled_after_hours_group_bookings(jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_controlled_after_hours_group_bookings(jsonb, uuid)
  TO service_role;

COMMENT ON FUNCTION public.insert_controlled_after_hours_group_bookings(jsonb, uuid) IS
  'Private Owner/Admin-only atomic group insert for explicit staff-approved after-hours appointments.';

-- Replace the customer reschedule RPC so the locked booking row is the source
-- of the old timestamp and occupied duration.  The submitted end timestamp is
-- retained only for signature compatibility; callers cannot shorten a block.
DROP FUNCTION IF EXISTS public.reschedule_booking_as_customer(
  uuid, timestamptz, timestamptz
);

CREATE FUNCTION public.reschedule_booking_as_customer(
  p_token_id uuid,
  p_new_start_utc timestamptz,
  p_new_end_utc timestamptz
)
RETURNS TABLE (
  ok boolean,
  code text,
  booking_id uuid,
  salon_id uuid,
  service_id uuid,
  service_name text,
  staff_name text,
  previous_start_utc timestamptz,
  new_start_utc timestamptz,
  new_end_utc timestamptz,
  policy_locked_by_reschedule boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_token public.booking_reminder_tokens%rowtype;
  v_booking public.bookings%rowtype;
  v_now timestamptz := clock_timestamp();
  v_authoritative_end timestamptz;
  v_block interval;
  v_timezone text;
  v_hours jsonb;
  v_closed_dates jsonb;
  v_lead_minutes integer;
  v_capability_mode text;
  v_resources_enabled boolean;
  v_local_start timestamp;
  v_local_end timestamp;
  v_day text;
  v_day_config jsonb;
  v_open time;
  v_close time;
  v_shift public.staff_shifts%rowtype;
  v_resource_id uuid;
  v_lock_id uuid;
  v_self_cancel_enabled boolean := false;
  v_window_hours integer := 24;
  v_self_cancel_percent integer;
  v_noshow_percent integer;
  v_lock_at timestamptz;
  v_lock_cents integer;
  v_service_name text;
  v_staff_name text;
BEGIN
  IF p_token_id IS NULL OR p_new_start_utc IS NULL OR p_new_end_utc IS NULL
     OR p_new_end_utc <= p_new_start_utc THEN
    RETURN QUERY SELECT false, 'invalid_slot'::text,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
      NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  SELECT * INTO v_token
  FROM public.booking_reminder_tokens t
  WHERE t.id = p_token_id
    AND t.used_at IS NULL
    AND t.expires_at > v_now
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'token_invalid'::text,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
      NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  SELECT * INTO v_booking
  FROM public.bookings b
  WHERE b.id = v_token.booking_id
    AND b.salon_id = v_token.salon_id
    AND b.status IN ('pending', 'confirmed')
    AND b.deleted_at IS NULL
    AND b.start_time_utc > v_now
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'booking_not_reschedulable'::text,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
      NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  v_block := v_booking.end_time_utc - v_booking.start_time_utc;
  IF v_block <= interval '0' OR v_block > interval '12 hours' THEN
    RETURN QUERY SELECT false, 'invalid_booking_duration'::text,
      v_booking.id, v_booking.salon_id, v_booking.service_id,
      NULL::text, NULL::text, v_booking.start_time_utc,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;
  v_authoritative_end := p_new_start_utc + v_block;

  SELECT
    nullif(trim(s.timezone), ''),
    s.opening_hours,
    coalesce(s.booking_closed_dates, '[]'::jsonb),
    greatest(coalesce(s.booking_lead_minutes, 15), 0),
    coalesce(s.staff_capability_mode, 'legacy_all'),
    coalesce(s.resources_enabled, false),
    coalesce(s.self_cancel_fee_enabled, false),
    CASE WHEN coalesce(s.self_cancel_window_hours, 0) > 0
      THEN s.self_cancel_window_hours ELSE 24 END,
    s.self_cancel_fee_percent,
    s.noshow_fee_percent
  INTO
    v_timezone, v_hours, v_closed_dates, v_lead_minutes,
    v_capability_mode, v_resources_enabled, v_self_cancel_enabled,
    v_window_hours, v_self_cancel_percent, v_noshow_percent
  FROM public.salons s
  WHERE s.id = v_booking.salon_id;

  IF NOT FOUND OR v_timezone IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names n WHERE n.name = v_timezone
  ) THEN
    RETURN QUERY SELECT false, 'salon_policy_unavailable'::text,
      v_booking.id, v_booking.salon_id, v_booking.service_id,
      NULL::text, NULL::text, v_booking.start_time_utc,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;
  IF p_new_start_utc < v_now + make_interval(mins => v_lead_minutes) THEN
    RETURN QUERY SELECT false, 'booking_lead_time'::text,
      v_booking.id, v_booking.salon_id, v_booking.service_id,
      NULL::text, NULL::text, v_booking.start_time_utc,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;
  IF p_new_start_utc > v_now + interval '1 year' THEN
    RETURN QUERY SELECT false, 'booking_horizon'::text,
      v_booking.id, v_booking.salon_id, v_booking.service_id,
      NULL::text, NULL::text, v_booking.start_time_utc,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.staff st
    WHERE st.id = v_booking.staff_id
      AND st.salon_id = v_booking.salon_id
      AND st.status = 'active'
      AND st.deleted_at IS NULL
  ) THEN
    RETURN QUERY SELECT false, 'invalid_staff'::text,
      v_booking.id, v_booking.salon_id, v_booking.service_id,
      NULL::text, NULL::text, v_booking.start_time_utc,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;
  IF v_capability_mode = 'whitelist' AND (
    NOT EXISTS (
      SELECT 1 FROM public.staff_services ss
      WHERE ss.staff_id = v_booking.staff_id
        AND ss.service_id = v_booking.service_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.booking_addons ba
      WHERE ba.booking_id = v_booking.id
        AND ba.service_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.staff_services ss
          WHERE ss.staff_id = v_booking.staff_id
            AND ss.service_id = ba.service_id
        )
    )
  ) THEN
    RETURN QUERY SELECT false, 'staff_incapable'::text,
      v_booking.id, v_booking.salon_id, v_booking.service_id,
      NULL::text, NULL::text, v_booking.start_time_utc,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  v_local_start := public.salon_local_timestamp(p_new_start_utc, v_timezone);
  v_local_end := public.salon_local_timestamp(v_authoritative_end, v_timezone);
  IF v_local_start::date <> v_local_end::date THEN
    RETURN QUERY SELECT false, 'outside_hours'::text,
      v_booking.id, v_booking.salon_id, v_booking.service_id,
      NULL::text, NULL::text, v_booking.start_time_utc,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;
  IF jsonb_typeof(v_closed_dates) = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_closed_dates) d(value)
    WHERE d.value = to_char(v_local_start, 'YYYY-MM-DD')
  ) THEN
    RETURN QUERY SELECT false, 'closed_day'::text,
      v_booking.id, v_booking.salon_id, v_booking.service_id,
      NULL::text, NULL::text, v_booking.start_time_utc,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;
  v_day := lower(to_char(v_local_start, 'Dy'));
  v_day_config := v_hours -> v_day;
  IF jsonb_typeof(v_day_config) <> 'object'
     OR coalesce((v_day_config->>'closed')::boolean, false)
     OR nullif(trim(v_day_config->>'open'), '') IS NULL
     OR nullif(trim(v_day_config->>'close'), '') IS NULL THEN
    RETURN QUERY SELECT false, 'outside_hours'::text,
      v_booking.id, v_booking.salon_id, v_booking.service_id,
      NULL::text, NULL::text, v_booking.start_time_utc,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;
  BEGIN
    v_open := (v_day_config->>'open')::time;
    v_close := (v_day_config->>'close')::time;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN QUERY SELECT false, 'outside_hours'::text,
      v_booking.id, v_booking.salon_id, v_booking.service_id,
      NULL::text, NULL::text, v_booking.start_time_utc,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END;
  -- Fail closed for legacy rows whose final cleanup buffer was not snapshotted:
  -- the complete occupied block must remain inside normal opening hours.
  IF v_close <= v_open OR v_local_start::time < v_open
     OR v_local_start::time >= v_close OR v_local_end::time > v_close
     OR (
       v_local_end <= v_local_start
       AND EXISTS (
         SELECT 1
         FROM pg_catalog.generate_series(
           p_new_start_utc,
           v_authoritative_end - interval '1 second',
           interval '1 minute'
         ) AS sample(instant)
         WHERE public.salon_local_timestamp(sample.instant, v_timezone)::date
                 <> v_local_start::date
            OR public.salon_local_timestamp(sample.instant, v_timezone)::time < v_open
            OR public.salon_local_timestamp(sample.instant, v_timezone)::time >= v_close
       )
     ) THEN
    RETURN QUERY SELECT false, 'outside_hours'::text,
      v_booking.id, v_booking.salon_id, v_booking.service_id,
      NULL::text, NULL::text, v_booking.start_time_utc,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.staff_unavailability u
    WHERE u.salon_id = v_booking.salon_id
      AND u.staff_id = v_booking.staff_id
      AND u.date = v_local_start::date
  ) THEN
    RETURN QUERY SELECT false, 'staff_unavailable'::text,
      v_booking.id, v_booking.salon_id, v_booking.service_id,
      NULL::text, NULL::text, v_booking.start_time_utc,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  SELECT * INTO v_shift
  FROM public.staff_shifts sh
  WHERE sh.salon_id = v_booking.salon_id
    AND sh.staff_id = v_booking.staff_id
    AND sh.day_of_week = v_day
    AND sh.is_active IS TRUE;
  IF FOUND THEN
    IF v_local_start::time < v_shift.start_time::time
       OR v_local_end::time > v_shift.end_time::time
       OR (
         v_local_end <= v_local_start
         AND EXISTS (
           SELECT 1
           FROM pg_catalog.generate_series(
             p_new_start_utc,
             v_authoritative_end - interval '1 second',
             interval '1 minute'
           ) AS sample(instant)
           WHERE public.salon_local_timestamp(sample.instant, v_timezone)::time
                   < v_shift.start_time::time
              OR public.salon_local_timestamp(sample.instant, v_timezone)::time
                   >= v_shift.end_time::time
         )
       ) THEN
      RETURN QUERY SELECT false, 'outside_shift'::text,
        v_booking.id, v_booking.salon_id, v_booking.service_id,
        NULL::text, NULL::text, v_booking.start_time_utc,
        NULL::timestamptz, NULL::timestamptz, false;
      RETURN;
    END IF;
    IF v_shift.break_start_time IS NOT NULL
       AND v_shift.break_end_time IS NOT NULL
       AND (
         (
           v_local_end > v_local_start
           AND v_local_start::time < v_shift.break_end_time
           AND v_local_end::time > v_shift.break_start_time
         )
         OR (
           v_local_end <= v_local_start
           AND EXISTS (
             SELECT 1
             FROM pg_catalog.generate_series(
               p_new_start_utc,
               v_authoritative_end - interval '1 second',
               interval '1 minute'
             ) AS sample(instant)
             WHERE public.salon_local_timestamp(sample.instant, v_timezone)::time
                     >= v_shift.break_start_time
               AND public.salon_local_timestamp(sample.instant, v_timezone)::time
                     < v_shift.break_end_time
           )
         )
       ) THEN
      RETURN QUERY SELECT false, 'staff_break'::text,
        v_booking.id, v_booking.salon_id, v_booking.service_id,
        NULL::text, NULL::text, v_booking.start_time_utc,
        NULL::timestamptz, NULL::timestamptz, false;
      RETURN;
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_booking.salon_id::text || chr(255) || v_booking.staff_id::text)::bigint
  );
  IF EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.id <> v_booking.id
      AND b.salon_id = v_booking.salon_id
      AND b.staff_id = v_booking.staff_id
      AND b.deleted_at IS NULL
      AND b.status NOT IN ('cancelled', 'no_show', 'completed')
      AND b.start_time_utc < v_authoritative_end
      AND b.end_time_utc > p_new_start_utc
  ) THEN
    RETURN QUERY SELECT false, 'slot_conflict'::text,
      v_booking.id, v_booking.salon_id, v_booking.service_id,
      NULL::text, NULL::text, v_booking.start_time_utc,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  v_resource_id := NULL;
  IF v_resources_enabled THEN
    FOR v_lock_id IN
      SELECT r.id FROM public.salon_resources r
      WHERE r.salon_id = v_booking.salon_id
        AND r.status = 'active' AND r.deleted_at IS NULL
      ORDER BY r.id
    LOOP
      PERFORM pg_advisory_xact_lock(
        hashtext(v_booking.salon_id::text || chr(254) || v_lock_id::text)::bigint
      );
    END LOOP;

    IF v_booking.resource_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.salon_resources r
      WHERE r.id = v_booking.resource_id
        AND r.salon_id = v_booking.salon_id
        AND r.status = 'active' AND r.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.bookings b
          WHERE b.id <> v_booking.id
            AND b.salon_id = v_booking.salon_id
            AND b.resource_id = r.id
            AND b.deleted_at IS NULL
            AND b.status NOT IN ('cancelled', 'no_show')
            AND b.start_time_utc < v_authoritative_end
            AND b.end_time_utc > p_new_start_utc
        )
    ) THEN
      v_resource_id := v_booking.resource_id;
    ELSE
      SELECT r.id INTO v_resource_id
      FROM public.salon_resources r
      WHERE r.salon_id = v_booking.salon_id
        AND r.status = 'active' AND r.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.bookings b
          WHERE b.id <> v_booking.id
            AND b.salon_id = v_booking.salon_id
            AND b.resource_id = r.id
            AND b.deleted_at IS NULL
            AND b.status NOT IN ('cancelled', 'no_show')
            AND b.start_time_utc < v_authoritative_end
            AND b.end_time_utc > p_new_start_utc
        )
      ORDER BY r.display_order ASC NULLS LAST, r.id
      LIMIT 1;
    END IF;
    IF v_resource_id IS NULL THEN
      RETURN QUERY SELECT false, 'resource_conflict'::text,
        v_booking.id, v_booking.salon_id, v_booking.service_id,
        NULL::text, NULL::text, v_booking.start_time_utc,
        NULL::timestamptz, NULL::timestamptz, false;
      RETURN;
    END IF;
  END IF;

  IF v_booking.self_cancel_fee_locked_at IS NULL
     AND v_self_cancel_enabled
     AND v_booking.start_time_utc < v_now + make_interval(hours => v_window_hours)
  THEN
    v_lock_cents := greatest(0, coalesce(v_booking.noshow_fee_cents, 0));
    IF v_self_cancel_percent IS NOT NULL AND coalesce(v_noshow_percent, 0) > 0 THEN
      v_lock_cents := round(
        v_lock_cents::numeric * v_self_cancel_percent::numeric
        / v_noshow_percent::numeric
      )::integer;
    END IF;
    IF v_lock_cents > 0 THEN v_lock_at := v_now; END IF;
  END IF;

  BEGIN
    UPDATE public.bookings b
    SET rescheduled_from_time_utc = b.start_time_utc,
        start_time_utc = p_new_start_utc,
        end_time_utc = v_authoritative_end,
        resource_id = CASE WHEN v_resources_enabled THEN v_resource_id ELSE b.resource_id END,
        rescheduled_at = v_now,
        rescheduled_by = 'customer',
        reminder_24h_sent_at = NULL,
        reminder_3h_sent_at = NULL,
        status = 'confirmed',
        self_cancel_fee_locked_at = coalesce(b.self_cancel_fee_locked_at, v_lock_at),
        self_cancel_fee_locked_cents = coalesce(b.self_cancel_fee_locked_cents, v_lock_cents),
        self_cancel_fee_lock_reason = coalesce(
          b.self_cancel_fee_lock_reason,
          CASE WHEN v_lock_at IS NOT NULL THEN 'customer_reschedule' END
        )
    WHERE b.id = v_booking.id AND b.salon_id = v_booking.salon_id;
  EXCEPTION WHEN exclusion_violation THEN
    RETURN QUERY SELECT false, 'slot_conflict'::text,
      v_booking.id, v_booking.salon_id, v_booking.service_id,
      NULL::text, NULL::text, v_booking.start_time_utc,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END;

  UPDATE public.booking_reminder_tokens t
  SET used_at = v_now, used_action = 'reschedule'
  WHERE t.id = v_token.id;

  UPDATE public.booking_waitlist_entries w
  SET status = 'notified',
      notified_at = v_now,
      claim_token = gen_random_uuid(),
      promotion_request_id = v_token.id,
      offered_staff_id = v_booking.staff_id,
      offered_start_utc = v_booking.start_time_utc,
      offered_end_utc = v_booking.end_time_utc
  WHERE w.id = (
    SELECT candidate.id
    FROM public.booking_waitlist_entries candidate
    WHERE candidate.salon_id = v_booking.salon_id
      AND candidate.service_id = v_booking.service_id
      AND candidate.booking_date =
        public.salon_local_timestamp(v_booking.start_time_utc, v_timezone)::date
      AND candidate.status = 'waiting'
    ORDER BY candidate.created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  );

  SELECT sv.name INTO v_service_name
  FROM public.services sv
  WHERE sv.id = v_booking.service_id AND sv.salon_id = v_booking.salon_id;
  SELECT st.name INTO v_staff_name
  FROM public.staff st
  WHERE st.id = v_booking.staff_id AND st.salon_id = v_booking.salon_id;

  RETURN QUERY SELECT true, 'ok'::text,
    v_booking.id, v_booking.salon_id, v_booking.service_id,
    v_service_name, v_staff_name, v_booking.start_time_utc,
    p_new_start_utc, v_authoritative_end, v_lock_at IS NOT NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.reschedule_booking_as_customer(uuid, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_booking_as_customer(uuid, timestamptz, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.reschedule_booking_as_customer(uuid, timestamptz, timestamptz) IS
  'Race-safe customer reschedule using the locked original block plus opening, closed-date, lead/horizon, durable capability, shift/break, unavailability and resource policies.';

-- Migration-time security proof. A later replacement must not silently reopen
-- private writers or restore a caller-controlled search_path.
DO $proof$
DECLARE
  v_oid oid;
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'insert_group_bookings_unlimited(jsonb)',
    'insert_controlled_after_hours_group_bookings(jsonb,uuid)',
    'reschedule_booking_as_customer(uuid,timestamp with time zone,timestamp with time zone)'
  ]
  LOOP
    v_oid := to_regprocedure('public.' || v_name)::oid;
    IF v_oid IS NULL
       OR NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = v_oid)
       OR NOT ('search_path=""' = ANY(coalesce(
         (SELECT p.proconfig FROM pg_catalog.pg_proc p WHERE p.oid = v_oid),
         ARRAY[]::text[]
       )))
       OR EXISTS (
         SELECT 1
         FROM aclexplode(coalesce(
           (SELECT p.proacl FROM pg_catalog.pg_proc p WHERE p.oid = v_oid),
           acldefault('f', (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = v_oid))
         )) acl
         WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
       )
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'private scheduling boundary security drift: %', v_name;
    END IF;
  END LOOP;

  v_oid := to_regprocedure('public.insert_group_bookings(jsonb,uuid)')::oid;
  IF v_oid IS NULL
     OR NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = v_oid)
     OR NOT ('search_path=""' = ANY(coalesce(
       (SELECT p.proconfig FROM pg_catalog.pg_proc p WHERE p.oid = v_oid),
       ARRAY[]::text[]
     )))
     OR EXISTS (
       SELECT 1
       FROM aclexplode(coalesce(
         (SELECT p.proacl FROM pg_catalog.pg_proc p WHERE p.oid = v_oid),
         acldefault('f', (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = v_oid))
       )) acl
       WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
     )
     OR NOT has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'public group scheduling boundary security drift';
  END IF;

  FOREACH v_name IN ARRAY ARRAY[
    'group_booking_request_completed(uuid,uuid)',
    'validate_group_booking_otp_session(uuid,uuid,text,uuid)'
  ]
  LOOP
    v_oid := to_regprocedure('public.' || v_name)::oid;
    IF v_oid IS NULL
       OR NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = v_oid)
       OR NOT ('search_path=""' = ANY(coalesce(
         (SELECT p.proconfig FROM pg_catalog.pg_proc p WHERE p.oid = v_oid),
         ARRAY[]::text[]
       )))
       OR EXISTS (
         SELECT 1
         FROM aclexplode(coalesce(
           (SELECT p.proacl FROM pg_catalog.pg_proc p WHERE p.oid = v_oid),
           acldefault('f', (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = v_oid))
         )) acl
         WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
       )
       OR NOT has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'public group retry helper security drift: %', v_name;
    END IF;
  END LOOP;

  IF has_table_privilege('anon', 'public.group_booking_requests', 'SELECT')
     OR has_table_privilege('authenticated', 'public.group_booking_requests', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.group_booking_requests', 'SELECT') THEN
    RAISE EXCEPTION 'group request ledger privilege drift';
  END IF;
END;
$proof$;

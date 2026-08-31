-- Smart Capacity Rescue keeps one canonical, opt-in waitlist receipt for
-- individual, multi-service, and group demand. Existing individual waitlist
-- workers continue to process only status='waiting'. Complex requests enter
-- review_required so they can never be mistaken for one free chair/slot.

ALTER TABLE public.booking_waitlist_entries
  ADD COLUMN IF NOT EXISTS request_kind text NOT NULL DEFAULT 'individual',
  ADD COLUMN IF NOT EXISTS party_size integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS request_id uuid,
  ADD COLUMN IF NOT EXISTS intent_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS intent_fingerprint text,
  ADD COLUMN IF NOT EXISTS client_locale text NOT NULL DEFAULT 'en';

ALTER TABLE public.booking_waitlist_entries
  DROP CONSTRAINT IF EXISTS bwe_status_check;

ALTER TABLE public.booking_waitlist_entries
  ADD CONSTRAINT bwe_status_check CHECK (
    status = ANY (ARRAY[
      'waiting'::text,
      'review_required'::text,
      'notified'::text,
      'claimed'::text,
      'expired'::text
    ])
  ),
  ADD CONSTRAINT booking_waitlist_request_kind_check CHECK (
    request_kind = ANY (ARRAY[
      'individual'::text,
      'sequence'::text,
      'group'::text
    ])
  ),
  ADD CONSTRAINT booking_waitlist_party_size_check CHECK (
    party_size BETWEEN 1 AND 20
    AND (request_kind <> 'group' OR party_size >= 2)
    AND (request_kind = 'group' OR party_size = 1)
  ),
  ADD CONSTRAINT booking_waitlist_intent_object_check CHECK (
    jsonb_typeof(intent_json) = 'object'
  ),
  ADD CONSTRAINT booking_waitlist_locale_check CHECK (
    client_locale = ANY (ARRAY['en'::text, 'vi'::text])
  );

CREATE UNIQUE INDEX IF NOT EXISTS booking_waitlist_request_id_unique
  ON public.booking_waitlist_entries (salon_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS booking_waitlist_active_intent_unique
  ON public.booking_waitlist_entries (salon_id, intent_fingerprint)
  WHERE intent_fingerprint IS NOT NULL
    AND status IN ('waiting', 'review_required', 'notified');

CREATE INDEX IF NOT EXISTS booking_waitlist_review_queue
  ON public.booking_waitlist_entries (salon_id, created_at, id)
  WHERE status = 'review_required';

COMMENT ON COLUMN public.booking_waitlist_entries.request_kind IS
  'individual uses the existing single-slot claim worker; sequence/group require a capacity plan before any offer.';
COMMENT ON COLUMN public.booking_waitlist_entries.intent_json IS
  'Validated scheduling constraints only. No prices, card data, OTPs, health notes, or provider material.';

CREATE OR REPLACE FUNCTION public.create_public_capacity_rescue_request(
  p_salon_id uuid,
  p_request_id uuid,
  p_request_kind text,
  p_primary_service_id uuid,
  p_staff_id uuid,
  p_booking_date date,
  p_preferred_slot_label text,
  p_party_size integer,
  p_client_name text,
  p_client_phone text,
  p_client_email text,
  p_client_locale text,
  p_intent_json jsonb
)
RETURNS TABLE(id uuid, status text, created_new boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_kind text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_request_kind, '')));
  v_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_client_locale, 'en')));
  v_name text := pg_catalog.btrim(coalesce(p_client_name, ''));
  v_phone text := pg_catalog.regexp_replace(coalesce(p_client_phone, ''), '[^0-9]', '', 'g');
  v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_client_email, '')));
  v_slot text := nullif(pg_catalog.btrim(coalesce(p_preferred_slot_label, '')), '');
  v_intent jsonb := coalesce(p_intent_json, '{}'::jsonb);
  v_service_ids jsonb;
  v_service_text text;
  v_service_id uuid;
  v_salon_tz text;
  v_today date;
  v_fingerprint text;
  v_existing public.booking_waitlist_entries%ROWTYPE;
  v_inserted public.booking_waitlist_entries%ROWTYPE;
BEGIN
  IF v_role NOT IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required';
  END IF;

  IF v_kind NOT IN ('individual', 'sequence', 'group') THEN
    RAISE EXCEPTION 'invalid_request_kind';
  END IF;

  IF v_locale NOT IN ('en', 'vi') THEN
    RAISE EXCEPTION 'invalid_locale';
  END IF;

  IF p_party_size IS NULL OR p_party_size < 1 OR p_party_size > 20
     OR (v_kind = 'group' AND p_party_size < 2)
     OR (v_kind <> 'group' AND p_party_size <> 1) THEN
    RAISE EXCEPTION 'invalid_party_size';
  END IF;

  IF pg_catalog.length(v_name) NOT BETWEEN 1 AND 120
     OR v_name ~ '[[:cntrl:]<>]' THEN
    RAISE EXCEPTION 'invalid_client_name';
  END IF;

  IF pg_catalog.length(v_phone) NOT BETWEEN 8 AND 15 THEN
    RAISE EXCEPTION 'invalid_phone';
  END IF;

  IF pg_catalog.length(v_email) > 254
     OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;

  IF jsonb_typeof(v_intent) <> 'object'
     OR pg_catalog.octet_length(v_intent::text) > 32768 THEN
    RAISE EXCEPTION 'invalid_intent';
  END IF;

  -- This public boundary accepts scheduling constraints only. Reject unknown
  -- top-level keys and sensitive-looking nested keys even though workers never
  -- act on complex requests automatically.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_object_keys(v_intent) AS intent_key(key)
    WHERE NOT (
      (v_kind = 'individual' AND intent_key.key IN ('serviceIds', 'staffPreference', 'source'))
      OR (v_kind = 'sequence' AND intent_key.key IN (
        'serviceIds', 'requestedStartTimeUtc', 'sameStaffForAll', 'lines'
      ))
      OR (v_kind = 'group' AND intent_key.key IN (
        'serviceIds', 'syncMode', 'finishTime', 'arrivalPreference',
        'seatTogether', 'members'
      ))
    )
  ) OR v_intent::text ~* '"[^"[:space:]]*(card|otp|health|note|price|provider|token|secret)[^"]*"[[:space:]]*:' THEN
    RAISE EXCEPTION 'invalid_intent_keys';
  END IF;

  IF v_kind = 'individual' AND (
    v_intent ->> 'source' NOT IN ('slot_unavailable', 'booking_conflict')
    OR coalesce(v_intent ->> 'staffPreference', '') = ''
  ) THEN
    RAISE EXCEPTION 'invalid_individual_intent';
  END IF;

  IF v_kind = 'sequence' AND (
    jsonb_typeof(v_intent -> 'lines') <> 'array'
    OR jsonb_array_length(v_intent -> 'lines') NOT BETWEEN 1 AND 5
    OR jsonb_typeof(v_intent -> 'sameStaffForAll') <> 'boolean'
    OR coalesce(v_intent ->> 'requestedStartTimeUtc', '') = ''
  ) THEN
    RAISE EXCEPTION 'invalid_sequence_intent';
  END IF;

  IF v_kind = 'group' AND (
    jsonb_typeof(v_intent -> 'members') <> 'array'
    OR jsonb_array_length(v_intent -> 'members') <> p_party_size
    OR v_intent ->> 'syncMode' NOT IN ('sync_start', 'sync_finish')
    OR jsonb_typeof(v_intent -> 'seatTogether') <> 'boolean'
    OR jsonb_typeof(v_intent -> 'arrivalPreference') <> 'object'
  ) THEN
    RAISE EXCEPTION 'invalid_group_intent';
  END IF;

  v_service_ids := v_intent -> 'serviceIds';
  IF jsonb_typeof(v_service_ids) <> 'array'
     OR jsonb_array_length(v_service_ids) < 1
     OR jsonb_array_length(v_service_ids) > 20 THEN
    RAISE EXCEPTION 'invalid_services';
  END IF;

  IF NOT (v_service_ids ? p_primary_service_id::text) THEN
    RAISE EXCEPTION 'primary_service_missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.services AS service
    WHERE service.id = p_primary_service_id
      AND service.salon_id = p_salon_id
      AND service.deleted_at IS NULL
      AND NOT service.is_addon
  ) THEN
    RAISE EXCEPTION 'invalid_service_for_salon';
  END IF;

  FOR v_service_text IN
    SELECT value FROM pg_catalog.jsonb_array_elements_text(v_service_ids)
  LOOP
    BEGIN
      v_service_id := v_service_text::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'invalid_services';
    END;

    IF NOT EXISTS (
      SELECT 1
      FROM public.services AS service
      WHERE service.id = v_service_id
        AND service.salon_id = p_salon_id
        AND service.deleted_at IS NULL
        AND NOT service.is_addon
    ) THEN
      RAISE EXCEPTION 'invalid_services';
    END IF;
  END LOOP;

  IF p_staff_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.staff AS person
    WHERE person.id = p_staff_id
      AND person.salon_id = p_salon_id
      AND person.deleted_at IS NULL
      AND person.status = 'active'
  ) THEN
    RAISE EXCEPTION 'invalid_staff_for_salon';
  END IF;

  SELECT coalesce(nullif(pg_catalog.btrim(salon.timezone), ''), 'America/Los_Angeles')
    INTO v_salon_tz
  FROM public.salons AS salon
  WHERE salon.id = p_salon_id
    AND salon.profile_complete;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names AS zone WHERE zone.name = v_salon_tz
  ) THEN
    RAISE EXCEPTION 'salon_unavailable';
  END IF;

  v_today := (pg_catalog.transaction_timestamp() AT TIME ZONE v_salon_tz)::date;
  IF p_booking_date IS NULL
     OR p_booking_date < v_today
     OR p_booking_date > v_today + 365 THEN
    RAISE EXCEPTION 'invalid_booking_date';
  END IF;

  IF v_slot IS NOT NULL AND pg_catalog.length(v_slot) > 80 THEN
    RAISE EXCEPTION 'invalid_preferred_slot';
  END IF;

  v_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'kind', v_kind,
          'date', p_booking_date,
          'slot', v_slot,
          'partySize', p_party_size,
          'name', v_name,
          'phone', v_phone,
          'email', v_email,
          'locale', v_locale,
          'intent', v_intent
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  SELECT entry.* INTO v_existing
  FROM public.booking_waitlist_entries AS entry
  WHERE entry.salon_id = p_salon_id
    AND entry.request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.intent_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.status, false;
    RETURN;
  END IF;

  SELECT entry.* INTO v_existing
  FROM public.booking_waitlist_entries AS entry
  WHERE entry.salon_id = p_salon_id
    AND entry.intent_fingerprint = v_fingerprint
    AND entry.status IN ('waiting', 'review_required', 'notified')
  ORDER BY entry.created_at, entry.id
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing.id, v_existing.status, false;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.booking_waitlist_entries (
      salon_id,
      service_id,
      staff_id,
      booking_date,
      preferred_slot_label,
      client_name,
      client_phone,
      client_email,
      source,
      status,
      request_kind,
      party_size,
      request_id,
      intent_json,
      intent_fingerprint,
      client_locale
    ) VALUES (
      p_salon_id,
      p_primary_service_id,
      p_staff_id,
      p_booking_date,
      v_slot,
      v_name,
      v_phone,
      v_email,
      'slot_unavailable',
      CASE WHEN v_kind = 'individual' THEN 'waiting' ELSE 'review_required' END,
      v_kind,
      p_party_size,
      p_request_id,
      v_intent,
      v_fingerprint,
      v_locale
    )
    RETURNING * INTO v_inserted;
  EXCEPTION WHEN unique_violation THEN
    SELECT entry.* INTO v_existing
    FROM public.booking_waitlist_entries AS entry
    WHERE entry.salon_id = p_salon_id
      AND (
        entry.request_id = p_request_id
        OR (
          entry.intent_fingerprint = v_fingerprint
          AND entry.status IN ('waiting', 'review_required', 'notified')
        )
      )
    ORDER BY (entry.request_id = p_request_id) DESC, entry.created_at, entry.id
    LIMIT 1;
    IF NOT FOUND OR v_existing.intent_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'capacity_rescue_conflict';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.status, false;
    RETURN;
  END;

  RETURN QUERY SELECT v_inserted.id, v_inserted.status, true;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_public_capacity_rescue_request(
  uuid, uuid, text, uuid, uuid, date, text, integer,
  text, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.create_public_capacity_rescue_request(
  uuid, uuid, text, uuid, uuid, date, text, integer,
  text, text, text, text, jsonb
) TO anon, service_role;

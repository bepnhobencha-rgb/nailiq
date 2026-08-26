-- Public booking pricing integrity.
--
-- The legacy 14-argument public RPC accepted caller-supplied main and add-on
-- prices. Promotion, email-capture, voucher, combo and add-on metadata were
-- then written after commit from the browser, where anonymous booking RLS made
-- several writes silently affect zero rows. Phase A keeps the legacy signature
-- callable during the app rollout, while the browser moves to this ID-only
-- overload. Every monetary value is re-derived and persisted in the booking
-- transaction.

-- This Phase-A migration deliberately uses ordinary (transactional) unique
-- indexes so a failed migration rolls back as one unit. Bound the production
-- risk: do not wait behind traffic indefinitely, and refuse the blocking-index
-- design once either target table exceeds the reviewed small-table budget.
-- Larger datasets must use a separately approved CREATE INDEX CONCURRENTLY
-- rollout before this migration is attempted.
SET lock_timeout = '5s';
SET statement_timeout = '90s';

DO $preflight$
DECLARE
  v_bookings_rows bigint;
  v_redemptions_rows bigint;
  v_bookings_bytes bigint;
  v_redemptions_bytes bigint;
  v_booking_index regclass := pg_catalog.to_regclass(
    'public.idx_bookings_public_idempotency_once'
  );
  v_redemption_index regclass := pg_catalog.to_regclass(
    'public.idx_voucher_redemptions_booking_once'
  );
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.create_public_booking_unlimited_14(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'private public-booking insert engine is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.idempotency_key IS NOT NULL
      AND b.group_id IS NULL
      AND b.recovered_from_booking_id IS NULL
    GROUP BY b.salon_id, b.idempotency_key
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate ordinary booking idempotency keys require review';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.voucher_redemptions vr
    WHERE vr.booking_id IS NOT NULL
    GROUP BY vr.voucher_id, vr.booking_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate voucher booking redemptions require review';
  END IF;

  SELECT count(*), pg_catalog.pg_total_relation_size('public.bookings'::regclass)
  INTO v_bookings_rows, v_bookings_bytes
  FROM public.bookings;
  SELECT count(*), pg_catalog.pg_total_relation_size(
    'public.voucher_redemptions'::regclass
  )
  INTO v_redemptions_rows, v_redemptions_bytes
  FROM public.voucher_redemptions;

  IF v_bookings_rows > 50000
     OR v_bookings_bytes > 134217728
     OR v_redemptions_rows > 100000
     OR v_redemptions_bytes > 67108864 THEN
    RAISE EXCEPTION USING
      MESSAGE = 'blocking public-booking index budget exceeded; use the reviewed concurrent-index rollout',
      DETAIL = pg_catalog.format(
        'bookings rows=%s bytes=%s; voucher_redemptions rows=%s bytes=%s',
        v_bookings_rows, v_bookings_bytes,
        v_redemptions_rows, v_redemptions_bytes
      );
  END IF;

  IF v_booking_index IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_index i
       WHERE i.indexrelid = v_booking_index
         AND i.indrelid = 'public.bookings'::regclass
         AND i.indisunique
         AND i.indisvalid
         AND i.indnkeyatts = 2
         AND i.indkey::text = pg_catalog.format(
           '%s %s',
           (SELECT a.attnum FROM pg_catalog.pg_attribute a
            WHERE a.attrelid = 'public.bookings'::regclass
              AND a.attname = 'salon_id'),
           (SELECT a.attnum FROM pg_catalog.pg_attribute a
            WHERE a.attrelid = 'public.bookings'::regclass
              AND a.attname = 'idempotency_key')
         )
         AND pg_catalog.pg_get_expr(i.indpred, i.indrelid) =
           '((idempotency_key IS NOT NULL) AND (group_id IS NULL) AND (recovered_from_booking_id IS NULL))'
     ) THEN
    RAISE EXCEPTION 'idx_bookings_public_idempotency_once definition mismatch';
  END IF;

  IF v_redemption_index IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_index i
       WHERE i.indexrelid = v_redemption_index
         AND i.indrelid = 'public.voucher_redemptions'::regclass
         AND i.indisunique
         AND i.indisvalid
         AND i.indnkeyatts = 2
         AND i.indkey::text = pg_catalog.format(
           '%s %s',
           (SELECT a.attnum FROM pg_catalog.pg_attribute a
            WHERE a.attrelid = 'public.voucher_redemptions'::regclass
              AND a.attname = 'voucher_id'),
           (SELECT a.attnum FROM pg_catalog.pg_attribute a
            WHERE a.attrelid = 'public.voucher_redemptions'::regclass
              AND a.attname = 'booking_id')
         )
         AND pg_catalog.pg_get_expr(i.indpred, i.indrelid) =
           '(booking_id IS NOT NULL)'
     ) THEN
    RAISE EXCEPTION 'idx_voucher_redemptions_booking_once definition mismatch';
  END IF;
END;
$preflight$;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS public_booking_request_fingerprint text,
  ADD COLUMN IF NOT EXISTS public_booking_pricing_fingerprint text,
  ADD COLUMN IF NOT EXISTS public_booking_pricing_snapshot jsonb;

DO $booking_fingerprint_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.bookings'::regclass
      AND c.conname = 'bookings_public_request_fingerprint_check'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_public_request_fingerprint_check
      CHECK (
        public_booking_request_fingerprint IS NULL
        OR public_booking_request_fingerprint ~ '^[0-9a-f]{64}$'
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.bookings'::regclass
      AND c.conname = 'bookings_public_pricing_fingerprint_check'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_public_pricing_fingerprint_check
      CHECK (
        public_booking_pricing_fingerprint IS NULL
        OR public_booking_pricing_fingerprint ~ '^[0-9a-f]{64}$'
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.bookings'::regclass
      AND c.conname = 'bookings_public_pricing_snapshot_check'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_public_pricing_snapshot_check
      CHECK (
        public_booking_pricing_snapshot IS NULL
        OR pg_catalog.jsonb_typeof(public_booking_pricing_snapshot) = 'object'
      ) NOT VALID;
  END IF;
END;
$booking_fingerprint_constraints$;

ALTER TABLE public.bookings
  VALIDATE CONSTRAINT bookings_public_request_fingerprint_check,
  VALIDATE CONSTRAINT bookings_public_pricing_fingerprint_check,
  VALIDATE CONSTRAINT bookings_public_pricing_snapshot_check;

COMMENT ON COLUMN public.bookings.public_booking_request_fingerprint IS
  'SHA-256 of the normalized ID-only public booking payload; binds idempotent replay to the original request.';
COMMENT ON COLUMN public.bookings.public_booking_pricing_fingerprint IS
  'SHA-256 of the authoritative public booking quote accepted at create time.';
COMMENT ON COLUMN public.bookings.public_booking_pricing_snapshot IS
  'Authoritative quote persisted with the booking so a replay never recomputes mutable pricing.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_public_idempotency_once
  ON public.bookings (salon_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND group_id IS NULL
    AND recovered_from_booking_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_voucher_redemptions_booking_once
  ON public.voucher_redemptions (voucher_id, booking_id)
  WHERE booking_id IS NOT NULL;

-- Historical confirmation rows predate durable provider receipts, so this
-- remains NOT VALID during Phase A. PostgreSQL still enforces a NOT VALID CHECK
-- for every new row and every row updated after this migration. The existing
-- twilio_message_sid column is the generic provider-receipt slot for both
-- Twilio SIDs and Resend message IDs.
DO $booking_confirmation_provider_receipt$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.booking_notifications'::regclass
      AND c.conname = 'booking_notifications_confirmation_sent_receipt_check'
  ) THEN
    ALTER TABLE public.booking_notifications
      ADD CONSTRAINT booking_notifications_confirmation_sent_receipt_check
      CHECK (
        notification_type <> 'booking_confirmation'
        OR status <> 'sent'
        OR nullif(trim(coalesce(twilio_message_sid, '')), '') IS NOT NULL
      ) NOT VALID;
  END IF;
END;
$booking_confirmation_provider_receipt$;

-- Provider sends cannot share booking_notifications' customer-confirmation key:
-- one owner alert is sent per resolved recipient. Keep an independent durable
-- claim so retries cannot send a second manager email after an ambiguous HTTP
-- response from the provider.
CREATE TABLE IF NOT EXISTS public.owner_booking_notification_claims (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  recipient_identity text NOT NULL,
  event_occurrence_key text NOT NULL,
  status text NOT NULL DEFAULT 'sending',
  attempt_count integer NOT NULL DEFAULT 1,
  provider_message_id text,
  last_error text,
  claimed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT owner_booking_notification_claims_event_check
    CHECK (event_type IN ('new', 'reschedule', 'cancel', 'no_show')),
  CONSTRAINT owner_booking_notification_claims_recipient_check
    CHECK (
      recipient_identity = lower(trim(recipient_identity))
      AND recipient_identity <> ''
      AND length(recipient_identity) <= 320
    ),
  CONSTRAINT owner_booking_notification_claims_occurrence_check
    CHECK (
      event_occurrence_key = lower(trim(event_occurrence_key))
      AND event_occurrence_key <> ''
      AND length(event_occurrence_key) <= 200
    ),
  CONSTRAINT owner_booking_notification_claims_status_check
    CHECK (status IN ('sending', 'sent', 'failed', 'unknown', 'suppressed')),
  CONSTRAINT owner_booking_notification_claims_attempt_check
    CHECK (attempt_count > 0),
  CONSTRAINT owner_booking_notification_claims_completion_check
    CHECK (
      (status = 'sending' AND completed_at IS NULL)
      OR (status <> 'sending' AND completed_at IS NOT NULL)
    ),
  CONSTRAINT owner_booking_notification_claims_sent_provider_check
    CHECK (
      status <> 'sent'
      OR nullif(trim(coalesce(provider_message_id, '')), '') IS NOT NULL
    ),
  CONSTRAINT owner_booking_notification_claims_once
    UNIQUE (
      booking_id, event_type, recipient_identity, event_occurrence_key
    )
);

CREATE INDEX IF NOT EXISTS owner_booking_notification_claims_salon_updated_idx
  ON public.owner_booking_notification_claims (salon_id, updated_at DESC);

ALTER TABLE public.owner_booking_notification_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.owner_booking_notification_claims
  FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.owner_booking_notification_claims
  TO service_role;

DO $owner_claim_policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy p
    WHERE p.polrelid = 'public.owner_booking_notification_claims'::regclass
      AND p.polname = 'deny direct API access to owner booking notification claims'
  ) THEN
    CREATE POLICY "deny direct API access to owner booking notification claims"
      ON public.owner_booking_notification_claims
      AS RESTRICTIVE FOR ALL TO anon, authenticated
      USING (false) WITH CHECK (false);
  END IF;
END;
$owner_claim_policy$;

CREATE OR REPLACE FUNCTION public.claim_owner_booking_notification(
  p_salon_id uuid,
  p_booking_id uuid,
  p_event_type text,
  p_recipient_identity text,
  p_event_occurrence_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $claim$
DECLARE
  v_recipient text := lower(trim(coalesce(p_recipient_identity, '')));
  v_occurrence text := lower(trim(coalesce(p_event_occurrence_key, '')));
  v_claim public.owner_booking_notification_claims%ROWTYPE;
BEGIN
  IF p_salon_id IS NULL
     OR p_booking_id IS NULL
     OR p_event_type NOT IN ('new', 'reschedule', 'cancel', 'no_show')
     OR v_recipient = ''
     OR length(v_recipient) > 320
     OR v_occurrence = ''
     OR length(v_occurrence) > 200
     OR NOT EXISTS (
       SELECT 1
       FROM public.bookings b
       WHERE b.id = p_booking_id
         AND b.salon_id = p_salon_id
     ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_claim');
  END IF;

  INSERT INTO public.owner_booking_notification_claims (
    salon_id,
    booking_id,
    event_type,
    recipient_identity,
    event_occurrence_key
  ) VALUES (
    p_salon_id,
    p_booking_id,
    p_event_type,
    v_recipient,
    v_occurrence
  )
  ON CONFLICT (
    booking_id, event_type, recipient_identity, event_occurrence_key
  ) DO NOTHING
  RETURNING * INTO v_claim;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'claimed',
      'claimed', true,
      'claim_id', v_claim.id,
      'status', v_claim.status,
      'attempt_count', v_claim.attempt_count
    );
  END IF;

  SELECT c.*
  INTO v_claim
  FROM public.owner_booking_notification_claims c
  WHERE c.booking_id = p_booking_id
    AND c.event_type = p_event_type
    AND c.recipient_identity = v_recipient
    AND c.event_occurrence_key = v_occurrence
  FOR UPDATE;

  -- A crashed sender may have handed the message to the provider before losing
  -- the response. Mark a stale in-flight attempt unknown and never auto-retry it.
  IF v_claim.status = 'sending'
     AND v_claim.updated_at < transaction_timestamp() - interval '15 minutes' THEN
    UPDATE public.owner_booking_notification_claims c
    SET status = 'unknown',
        completed_at = transaction_timestamp(),
        updated_at = transaction_timestamp(),
        last_error = coalesce(c.last_error, 'stale_sending_outcome_unknown')
    WHERE c.id = v_claim.id
    RETURNING * INTO v_claim;
  ELSIF v_claim.status = 'failed' THEN
    UPDATE public.owner_booking_notification_claims c
    SET status = 'sending',
        attempt_count = c.attempt_count + 1,
        provider_message_id = NULL,
        last_error = NULL,
        claimed_at = transaction_timestamp(),
        completed_at = NULL,
        updated_at = transaction_timestamp()
    WHERE c.id = v_claim.id
    RETURNING * INTO v_claim;

    RETURN jsonb_build_object(
      'success', true,
      'code', 'claimed',
      'claimed', true,
      'claim_id', v_claim.id,
      'status', v_claim.status,
      'attempt_count', v_claim.attempt_count
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'duplicate_suppressed',
    'claimed', false,
    'claim_id', v_claim.id,
    'status', v_claim.status,
    'attempt_count', v_claim.attempt_count
  );
END;
$claim$;

CREATE OR REPLACE FUNCTION public.complete_owner_booking_notification(
  p_claim_id uuid,
  p_status text,
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $complete$
DECLARE
  v_claim public.owner_booking_notification_claims%ROWTYPE;
BEGIN
  IF p_claim_id IS NULL
     OR p_status NOT IN ('sent', 'failed', 'unknown', 'suppressed')
     OR (
       p_status = 'sent'
       AND nullif(trim(coalesce(p_provider_message_id, '')), '') IS NULL
     ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_completion');
  END IF;

  SELECT c.*
  INTO v_claim
  FROM public.owner_booking_notification_claims c
  WHERE c.id = p_claim_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_not_found');
  END IF;

  IF v_claim.status <> 'sending' THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'already_completed',
      'status', v_claim.status
    );
  END IF;

  UPDATE public.owner_booking_notification_claims c
  SET status = p_status,
      provider_message_id = nullif(trim(coalesce(p_provider_message_id, '')), ''),
      last_error = nullif(left(coalesce(p_error, ''), 2000), ''),
      completed_at = transaction_timestamp(),
      updated_at = transaction_timestamp()
  WHERE c.id = p_claim_id;

  RETURN jsonb_build_object('success', true, 'code', 'completed', 'status', p_status);
END;
$complete$;

REVOKE ALL ON FUNCTION public.claim_owner_booking_notification(
  uuid, uuid, text, text, text
)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_owner_booking_notification(
  uuid, uuid, text, text, text
)
  TO service_role;
REVOKE ALL ON FUNCTION public.complete_owner_booking_notification(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_owner_booking_notification(uuid, text, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_public_booking_pricing(
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_start_time_utc timestamptz,
  p_end_time_utc timestamptz,
  p_addon_service_ids uuid[],
  p_combo_id uuid,
  p_voucher_id uuid,
  p_client_phone text,
  p_client_email text,
  p_apply_email_discount boolean,
  p_lock_claims boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $pricing$
DECLARE
  v_digits text := regexp_replace(coalesce(p_client_phone, ''), '\D', '', 'g');
  v_addon_ids uuid[] := coalesce(p_addon_service_ids, ARRAY[]::uuid[]);
  v_addon_count integer := 0;
  v_addon_price integer := 0;
  v_addon_block integer := 0;
  v_addon_lines jsonb := '[]'::jsonb;
  v_first_addon_id uuid;
  v_trailing_buffer integer := 0;
  v_service_price integer;
  v_service_duration integer;
  v_service_buffer integer;
  v_service_category text;
  v_salon_timezone text;
  v_currency text;
  v_tax_lines jsonb;
  v_opening_hours jsonb;
  v_closed_dates jsonb;
  v_combo_price integer;
  v_combo_duration integer;
  v_combo_service_ids uuid[] := ARRAY[]::uuid[];
  v_required_service_ids uuid[] := ARRAY[]::uuid[];
  v_base_price integer;
  v_service_net integer;
  v_final_service_price integer;
  v_final_addon_price integer;
  v_expected_block integer;
  v_expected_end timestamptz;
  v_operational_end timestamptz;
  v_start_local timestamp;
  v_end_local timestamp;
  v_day text;
  v_day_config jsonb;
  v_open_time time;
  v_close_time time;
  v_local_dow integer;
  v_local_time time;
  v_promo_id uuid;
  v_promo_name text;
  v_promo_discount integer := 0;
  v_email_discount integer := 0;
  v_voucher_discount integer := 0;
  v_voucher_row public.vouchers%ROWTYPE;
  v_existing_profile_id uuid;
  v_email_claimed_at timestamptz;
  v_pre_voucher_subtotal integer;
  v_subtotal integer;
  v_tax_amount integer := 0;
  v_total integer;
  v_tax_line jsonb;
  v_tax_rate numeric;
  v_tax_enabled boolean;
  v_tax_breakdown jsonb := '[]'::jsonb;
  v_tax_line_amount integer;
  v_material jsonb;
  v_fingerprint text;
BEGIN
  IF p_salon_id IS NULL
     OR p_service_id IS NULL
     OR p_staff_id IS NULL
     OR p_start_time_utc IS NULL
     OR p_end_time_utc IS NULL
     OR length(v_digits) < 7 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_input');
  END IF;

  IF pg_catalog.cardinality(v_addon_ids) > 8
     OR EXISTS (SELECT 1 FROM unnest(v_addon_ids) AS x(id) WHERE x.id IS NULL)
     OR (
       SELECT count(*)
       FROM (SELECT DISTINCT x.id FROM unnest(v_addon_ids) AS x(id)) d
     ) <> pg_catalog.cardinality(v_addon_ids) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_addon');
  END IF;

  SELECT
    s.price_cents,
    greatest(0, coalesce(s.duration_minutes, 0)),
    greatest(0, coalesce(s.buffer_minutes, 0)),
    s.category,
    coalesce(nullif(trim(sa.timezone), ''), 'America/Los_Angeles'),
    coalesce(nullif(trim(sa.currency_code), ''), 'USD'),
    sa.tax_lines,
    sa.opening_hours,
    coalesce(sa.booking_closed_dates, '[]'::jsonb)
  INTO
    v_service_price,
    v_service_duration,
    v_service_buffer,
    v_service_category,
    v_salon_timezone,
    v_currency,
    v_tax_lines,
    v_opening_hours,
    v_closed_dates
  FROM public.services s
  JOIN public.salons sa ON sa.id = s.salon_id
  WHERE s.id = p_service_id
    AND s.salon_id = p_salon_id
    AND s.deleted_at IS NULL
    AND s.is_addon IS FALSE;

  IF NOT FOUND
     OR v_service_price IS NULL
     OR v_service_price < 0
     OR v_service_duration < 1 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_reference');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names tz
    WHERE tz.name = v_salon_timezone
  ) THEN
    v_salon_timezone := 'America/Los_Angeles';
  END IF;

  SELECT
    count(*)::integer,
    coalesce(sum(s.price_cents), 0)::integer,
    coalesce(sum(
      CASE
        WHEN s.addon_timing = 'concurrent' THEN 0
        ELSE greatest(0, s.duration_minutes) + greatest(0, s.buffer_minutes)
      END
    ), 0)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'service_id', s.id,
          'name', s.name,
          'price_cents', s.price_cents,
          'duration_minutes', s.duration_minutes,
          'buffer_minutes', s.buffer_minutes,
          'addon_timing', s.addon_timing
        ) ORDER BY req.ord
      ),
      '[]'::jsonb
    ),
    (array_agg(s.id ORDER BY req.ord))[1],
    coalesce((
      array_agg(
        CASE
          WHEN s.addon_timing = 'concurrent' THEN NULL
          ELSE greatest(0, s.buffer_minutes)
        END
        ORDER BY req.ord DESC
      ) FILTER (WHERE s.addon_timing <> 'concurrent')
    )[1], 0)
  INTO
    v_addon_count,
    v_addon_price,
    v_addon_block,
    v_addon_lines,
    v_first_addon_id,
    v_trailing_buffer
  FROM unnest(v_addon_ids) WITH ORDINALITY AS req(id, ord)
  JOIN public.services s ON s.id = req.id
  WHERE s.salon_id = p_salon_id
    AND s.deleted_at IS NULL
    AND s.is_addon IS TRUE
    AND s.price_cents IS NOT NULL
    AND s.price_cents >= 0
    AND s.duration_minutes > 0;

  IF v_addon_count <> pg_catalog.cardinality(v_addon_ids) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_addon');
  END IF;

  IF p_combo_id IS NOT NULL THEN
    SELECT c.price_cents, c.duration_minutes, c.service_ids
    INTO v_combo_price, v_combo_duration, v_combo_service_ids
    FROM public.service_combos c
    WHERE c.id = p_combo_id
      AND c.salon_id = p_salon_id
      AND c.is_active IS TRUE
      AND p_service_id = ANY(c.service_ids);

    IF NOT FOUND
       OR v_combo_price < 0
       OR v_combo_duration < 1
       OR coalesce(pg_catalog.cardinality(v_combo_service_ids), 0) = 0
       OR EXISTS (
         SELECT 1
         FROM unnest(v_combo_service_ids) component(id)
         WHERE component.id IS NULL
       )
       OR (
         SELECT count(*)
         FROM (SELECT DISTINCT component.id FROM unnest(v_combo_service_ids) component(id)) d
       ) <> pg_catalog.cardinality(v_combo_service_ids)
       OR (
         SELECT count(*)
         FROM public.services component
         WHERE component.id = ANY(v_combo_service_ids)
           AND component.salon_id = p_salon_id
           AND component.deleted_at IS NULL
           AND component.is_addon IS FALSE
       ) <> pg_catalog.cardinality(v_combo_service_ids) THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_combo');
    END IF;

    v_base_price := v_combo_price;
    v_expected_block := v_combo_duration + v_addon_block;
  ELSE
    v_base_price := v_service_price;
    v_expected_block := v_service_duration + v_service_buffer + v_addon_block;
    IF v_addon_block = 0 THEN
      v_trailing_buffer := v_service_buffer;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.staff st
    WHERE st.id = p_staff_id
      AND st.salon_id = p_salon_id
      AND st.status = 'active'
      AND st.deleted_at IS NULL
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_staff');
  END IF;

  SELECT coalesce(array_agg(required.id ORDER BY required.id), ARRAY[]::uuid[])
  INTO v_required_service_ids
  FROM (
    SELECT DISTINCT id
    FROM unnest(
      CASE
        WHEN p_combo_id IS NULL THEN ARRAY[p_service_id]::uuid[] || v_addon_ids
        ELSE coalesce(v_combo_service_ids, ARRAY[]::uuid[]) || v_addon_ids
      END
    ) AS requested(id)
  ) required;

  -- Preserve the historic all-staff fallback only for salons that have no
  -- capability matrix at all. Once a salon configures staff_services, every
  -- component of a combo and every add-on must be explicitly assigned.
  IF EXISTS (
    SELECT 1
    FROM public.staff_services ss
    JOIN public.staff st ON st.id = ss.staff_id
    WHERE st.salon_id = p_salon_id
      AND st.status = 'active'
      AND st.deleted_at IS NULL
  ) AND (
    SELECT count(DISTINCT ss.service_id)
    FROM public.staff_services ss
    WHERE ss.staff_id = p_staff_id
      AND ss.service_id = ANY(v_required_service_ids)
  ) <> pg_catalog.cardinality(v_required_service_ids) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_staff_capability');
  END IF;

  v_expected_end := p_start_time_utc + pg_catalog.make_interval(mins => v_expected_block);
  IF p_end_time_utc IS DISTINCT FROM v_expected_end THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'invalid_time',
      'expected_end_time_utc', v_expected_end
    );
  END IF;

  v_operational_end := v_expected_end
    - pg_catalog.make_interval(mins => v_trailing_buffer);
  v_start_local := p_start_time_utc AT TIME ZONE v_salon_timezone;
  v_end_local := v_operational_end AT TIME ZONE v_salon_timezone;

  IF p_start_time_utc < clock_timestamp() + interval '2 minutes'
     OR v_opening_hours IS NULL
     OR pg_catalog.jsonb_typeof(v_opening_hours) <> 'object'
     OR v_start_local::date <> v_end_local::date
     OR (
       pg_catalog.jsonb_typeof(v_closed_dates) = 'array'
       AND EXISTS (
         SELECT 1
         FROM pg_catalog.jsonb_array_elements_text(v_closed_dates) closed(day)
         WHERE closed.day = pg_catalog.to_char(v_start_local, 'YYYY-MM-DD')
       )
     ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
  END IF;

  v_day := (ARRAY['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])[
    extract(dow FROM v_start_local)::integer + 1
  ];
  v_day_config := v_opening_hours -> v_day;
  IF pg_catalog.jsonb_typeof(v_day_config) <> 'object'
     OR (
       v_day_config->'closed' IS NOT NULL
       AND pg_catalog.jsonb_typeof(v_day_config->'closed') <> 'boolean'
     )
     OR nullif(trim(v_day_config->>'open'), '') IS NULL
     OR nullif(trim(v_day_config->>'close'), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
  END IF;

  IF coalesce((v_day_config->>'closed')::boolean, false) THEN
    RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
  END IF;

  BEGIN
    v_open_time := (v_day_config->>'open')::time;
    v_close_time := (v_day_config->>'close')::time;
  EXCEPTION WHEN invalid_datetime_format THEN
    RETURN jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
  END;

  IF v_close_time <= v_open_time
     OR v_start_local::time < v_open_time
     OR v_start_local::time >= v_close_time
     OR v_end_local::time > v_close_time
     OR v_end_local::time <= v_start_local::time THEN
    RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
  END IF;

  v_service_net := v_base_price;
  v_local_dow := extract(dow FROM p_start_time_utc AT TIME ZONE v_salon_timezone)::integer;
  v_local_time := (p_start_time_utc AT TIME ZONE v_salon_timezone)::time;

  -- A combo is already a server-authored bundle price. Until a separate combo
  -- promotion policy exists, never silently stack a service campaign on it.
  IF p_combo_id IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.promotions p
      LEFT JOIN public.promotion_services ps
        ON ps.promotion_id = p.id
       AND ps.service_id = p_service_id
      WHERE p.salon_id = p_salon_id
        AND p.active IS TRUE
        AND p_start_time_utc >= p.starts_at
        AND p_start_time_utc <= p.ends_at
        AND (p.applies_to = 'all' OR ps.id IS NOT NULL)
        AND (
          p.discount_value < 0
          OR (p.discount_type = 'percent' AND p.discount_value > 10000)
          OR ((p.time_start IS NULL) <> (p.time_end IS NULL))
          OR (p.time_start IS NOT NULL AND p.time_start = p.time_end)
          OR EXISTS (
            SELECT 1 FROM unnest(coalesce(p.days_of_week, ARRAY[]::integer[])) d
            WHERE d < 0 OR d > 6
          )
          OR (
            ps.id IS NOT NULL
            AND ((ps.discount_type IS NULL) <> (ps.discount_value IS NULL))
          )
          OR coalesce(ps.discount_value, p.discount_value) < 0
          OR (
            coalesce(ps.discount_type, p.discount_type) = 'percent'
            AND coalesce(ps.discount_value, p.discount_value) > 10000
          )
          OR (
            coalesce(ps.discount_type, p.discount_type) = 'fixed_price'
            AND coalesce(ps.discount_value, p.discount_value) > v_base_price
          )
        )
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
    END IF;

    SELECT candidate.id, candidate.name, candidate.discount_cents
    INTO v_promo_id, v_promo_name, v_promo_discount
    FROM (
      SELECT
        p.id,
        p.name,
        CASE coalesce(ps.discount_type, p.discount_type)
          WHEN 'fixed_price' THEN
            greatest(0, v_base_price - coalesce(ps.discount_value, p.discount_value))
          WHEN 'amount' THEN
            least(v_base_price, coalesce(ps.discount_value, p.discount_value))
          WHEN 'percent' THEN
            round(
              v_base_price::numeric * coalesce(ps.discount_value, p.discount_value)::numeric / 10000
            )::integer
          ELSE 0
        END AS discount_cents
      FROM public.promotions p
      LEFT JOIN public.promotion_services ps
        ON ps.promotion_id = p.id
       AND ps.service_id = p_service_id
      WHERE p.salon_id = p_salon_id
        AND p.active IS TRUE
        AND p_start_time_utc >= p.starts_at
        AND p_start_time_utc <= p.ends_at
        AND (p.applies_to = 'all' OR ps.id IS NOT NULL)
        AND (
          p.days_of_week IS NULL
          OR pg_catalog.cardinality(p.days_of_week) = 0
          OR v_local_dow = ANY(p.days_of_week)
        )
        AND (
          (p.time_start IS NULL AND p.time_end IS NULL)
          OR (
            p.time_start IS NOT NULL
            AND p.time_end IS NOT NULL
            AND p.time_start <> p.time_end
            AND (
              (p.time_end > p.time_start AND v_local_time >= p.time_start AND v_local_time < p.time_end)
              OR
              (p.time_end < p.time_start AND (v_local_time >= p.time_start OR v_local_time < p.time_end))
            )
          )
        )
        AND (
          ps.id IS NULL
          OR (ps.discount_type IS NULL AND ps.discount_value IS NULL)
          OR (ps.discount_type IS NOT NULL AND ps.discount_value IS NOT NULL)
        )
    ) candidate
    WHERE candidate.discount_cents > 0
    ORDER BY candidate.discount_cents DESC, candidate.id
    LIMIT 1;

    -- SELECT INTO clears target variables when no row matches. Preserve the
    -- declared zero for the normal no-promotion path so the authoritative
    -- receipt remains numerically complete and the fail-closed parser accepts
    -- it instead of treating a NULL discount as malformed pricing.
    IF FOUND THEN
      v_service_net := greatest(0, v_base_price - v_promo_discount);
    ELSE
      v_promo_discount := coalesce(v_promo_discount, 0);
    END IF;
  END IF;

  -- Every create request that can claim phone-bound value uses one lock order:
  -- canonical phone/profile first, voucher second, staff/resource last inside
  -- the booking insert. This removes profile↔voucher deadlocks.
  IF p_lock_claims
     AND (
       p_voucher_id IS NOT NULL
       OR (
         p_apply_email_discount IS TRUE
         AND nullif(trim(coalesce(p_client_email, '')), '') IS NOT NULL
       )
     ) THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('public-booking-client:' || v_digits, 0)
    );
  END IF;

  IF p_lock_claims
     AND (
       p_voucher_id IS NOT NULL
       OR p_apply_email_discount IS TRUE
     ) THEN
    SELECT cp.id, cp.email_discount_claimed_at
    INTO v_existing_profile_id, v_email_claimed_at
    FROM public.client_profiles cp
    WHERE cp.phone = v_digits
    FOR UPDATE;
  ELSE
    SELECT cp.id, cp.email_discount_claimed_at
    INTO v_existing_profile_id, v_email_claimed_at
    FROM public.client_profiles cp
    WHERE cp.phone = v_digits;
  END IF;

  IF p_apply_email_discount IS TRUE
     AND nullif(trim(coalesce(p_client_email, '')), '') IS NOT NULL
     AND (v_existing_profile_id IS NULL OR v_email_claimed_at IS NULL) THEN
    v_email_discount := least(200, v_service_net);
    v_service_net := greatest(0, v_service_net - v_email_discount);
  END IF;

  v_pre_voucher_subtotal := v_service_net + v_addon_price;

  IF p_voucher_id IS NOT NULL THEN
    IF p_lock_claims THEN
      SELECT v.*
      INTO v_voucher_row
      FROM public.vouchers v
      WHERE v.id = p_voucher_id
      FOR UPDATE;
    ELSE
      SELECT v.*
      INTO v_voucher_row
      FROM public.vouchers v
      WHERE v.id = p_voucher_id;
    END IF;

    IF NOT FOUND
       OR v_voucher_row.salon_id <> p_salon_id
       OR v_voucher_row.revoked_at IS NOT NULL
       OR transaction_timestamp() < v_voucher_row.valid_from
       OR transaction_timestamp() > v_voucher_row.expires_at
       OR v_voucher_row.used_count >= v_voucher_row.max_uses
       OR (
         v_voucher_row.client_phone IS NOT NULL
         AND regexp_replace(v_voucher_row.client_phone, '\D', '', 'g') <> v_digits
       )
       OR (
         v_voucher_row.client_profile_id IS NOT NULL
         AND v_voucher_row.client_profile_id IS DISTINCT FROM v_existing_profile_id
       )
       OR (
         coalesce(pg_catalog.cardinality(v_voucher_row.applicable_service_ids), 0) > 0
         AND NOT p_service_id = ANY(v_voucher_row.applicable_service_ids)
       )
       OR (
         v_voucher_row.applicable_service_category IS NOT NULL
         AND v_voucher_row.applicable_service_category <> v_service_category
       )
       OR coalesce(v_voucher_row.min_spend_cents, 0) > v_pre_voucher_subtotal THEN
      RETURN jsonb_build_object('success', false, 'code', 'voucher_invalid');
    END IF;

    IF v_voucher_row.percent_off IS NOT NULL THEN
      v_voucher_discount := floor(
        v_pre_voucher_subtotal::numeric * v_voucher_row.percent_off::numeric / 100
      )::integer;
    ELSIF v_voucher_row.amount_off_cents IS NOT NULL THEN
      v_voucher_discount := least(v_voucher_row.amount_off_cents, v_pre_voucher_subtotal);
    ELSIF v_voucher_row.free_service_id = p_service_id THEN
      v_voucher_discount := least(v_service_net, v_pre_voucher_subtotal);
    ELSE
      RETURN jsonb_build_object('success', false, 'code', 'voucher_invalid');
    END IF;

    v_voucher_discount := greatest(
      0,
      least(v_voucher_discount, v_pre_voucher_subtotal)
    );
    IF v_voucher_discount < 1 THEN
      RETURN jsonb_build_object('success', false, 'code', 'voucher_invalid');
    END IF;
  END IF;

  -- Store a final main-service and add-on split whose sum is exactly the
  -- authoritative subtotal. A subtotal-level voucher consumes the main price
  -- first, then the add-on aggregate.
  v_final_service_price := v_service_net;
  v_final_addon_price := v_addon_price;
  IF v_voucher_discount <= v_final_service_price THEN
    v_final_service_price := v_final_service_price - v_voucher_discount;
  ELSE
    v_final_addon_price := greatest(
      0,
      v_final_addon_price - (v_voucher_discount - v_final_service_price)
    );
    v_final_service_price := 0;
  END IF;
  v_subtotal := v_final_service_price + v_final_addon_price;

  IF pg_catalog.jsonb_typeof(v_tax_lines) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
  END IF;

  FOR v_tax_line IN SELECT value FROM pg_catalog.jsonb_array_elements(v_tax_lines)
  LOOP
    IF pg_catalog.jsonb_typeof(v_tax_line) <> 'object'
       OR v_tax_line->'name' IS NULL
       OR pg_catalog.jsonb_typeof(v_tax_line->'name') <> 'string'
       OR nullif(trim(v_tax_line->>'name'), '') IS NULL
       OR v_tax_line->'rate' IS NULL
       OR pg_catalog.jsonb_typeof(v_tax_line->'rate') <> 'number'
       OR (
         v_tax_line->'enabled' IS NOT NULL
         AND pg_catalog.jsonb_typeof(v_tax_line->'enabled') <> 'boolean'
       ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
    END IF;

    v_tax_rate := (v_tax_line->>'rate')::numeric;
    v_tax_enabled := coalesce((v_tax_line->>'enabled')::boolean, true);
    IF v_tax_rate < 0 OR v_tax_rate > 1 THEN
      RETURN jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
    END IF;
    IF v_tax_enabled AND v_tax_rate > 0 THEN
      v_tax_line_amount := round(v_subtotal::numeric * v_tax_rate)::integer;
      v_tax_amount := v_tax_amount + v_tax_line_amount;
      v_tax_breakdown := v_tax_breakdown || jsonb_build_array(
        jsonb_build_object(
          'name', trim(v_tax_line->>'name'),
          'rate', v_tax_rate,
          'amount_cents', v_tax_line_amount
        )
      );
    END IF;
  END LOOP;

  v_total := v_subtotal + v_tax_amount;
  v_material := jsonb_build_object(
    'salon_id', p_salon_id,
    'service_id', p_service_id,
    'staff_id', p_staff_id,
    'start_time_utc', p_start_time_utc,
    'end_time_utc', v_expected_end,
    'combo_id', p_combo_id,
    'service_combo_id', p_combo_id,
    'addon_service_ids', to_jsonb(v_addon_ids),
    'voucher_id', p_voucher_id,
    'currency', v_currency,
    'original_price_cents', v_base_price,
    'price_cents', v_final_service_price,
    'service_pre_voucher_cents', v_service_net,
    'addon_price_cents', v_final_addon_price,
    'addon_pre_voucher_cents', v_addon_price,
    'promo_id', v_promo_id,
    'promo_name', v_promo_name,
    'promo_discount_cents', v_promo_discount,
    'email_discount_cents', v_email_discount,
    'voucher_discount_cents', v_voucher_discount,
    'pre_voucher_subtotal_cents', v_pre_voucher_subtotal,
    'subtotal_cents', v_subtotal,
    'tax_cents', v_tax_amount,
    'tax_amount_cents', v_tax_amount,
    'total_cents', v_total,
    'tax_breakdown', v_tax_breakdown,
    'addon_lines', v_addon_lines,
    'first_addon_id', v_first_addon_id,
    'trailing_buffer_minutes', v_trailing_buffer
  );
  v_fingerprint := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_material::text, 'UTF8'), 'sha256'),
    'hex'
  );

  RETURN jsonb_build_object(
    'success', true,
    'code', 'quoted',
    'pricing_fingerprint', v_fingerprint
  ) || v_material;
END;
$pricing$;

REVOKE ALL ON FUNCTION public.resolve_public_booking_pricing(
  uuid, uuid, uuid, timestamptz, timestamptz, uuid[], uuid, uuid,
  text, text, boolean, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_public_booking_pricing(
  uuid, uuid, uuid, timestamptz, timestamptz, uuid[], uuid, uuid,
  text, text, boolean, boolean
) TO service_role;
-- Server callers may use this service-only wrapper; the app's same-origin,
-- rate-limited API currently calls the same internal resolver directly. Quote
-- and create therefore share one pricing implementation without handing anon a
-- second, unmetered Data API path around the route guard.
CREATE OR REPLACE FUNCTION public.quote_public_booking(
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_start_time_utc timestamptz,
  p_end_time_utc timestamptz,
  p_addon_service_ids uuid[],
  p_combo_id uuid,
  p_voucher_id uuid,
  p_client_phone text,
  p_client_email text,
  p_apply_email_discount boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $quote$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  RETURN public.resolve_public_booking_pricing(
    p_salon_id, p_service_id, p_staff_id, p_start_time_utc, p_end_time_utc,
    p_addon_service_ids, p_combo_id, p_voucher_id, p_client_phone,
    p_client_email, p_apply_email_discount, false
  );
END;
$quote$;

REVOKE ALL ON FUNCTION public.quote_public_booking(
  uuid, uuid, uuid, timestamptz, timestamptz, uuid[], uuid, uuid,
  text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_public_booking(
  uuid, uuid, uuid, timestamptz, timestamptz, uuid[], uuid, uuid,
  text, text, boolean
) TO service_role;

COMMENT ON FUNCTION public.quote_public_booking(
  uuid, uuid, uuid, timestamptz, timestamptz, uuid[], uuid, uuid,
  text, text, boolean
) IS
  'Read-only ID-based public booking quote. Returns the authoritative pricing snapshot and SHA-256 fingerprint used by create_public_booking.';

-- Remove the abandoned local-only 16-argument draft if a developer replayed it
-- before this migration was finalized. Production never depended on it.
DROP FUNCTION IF EXISTS public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, text, uuid[], text, uuid, uuid, uuid, boolean, uuid
);

CREATE OR REPLACE FUNCTION public.create_public_booking(
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_client_name text,
  p_client_phone text,
  p_start_time_utc timestamptz,
  p_end_time_utc timestamptz,
  p_status text,
  p_client_notes text,
  p_addon_service_ids uuid[],
  p_client_email text,
  p_resource_id uuid,
  p_combo_id uuid,
  p_voucher_id uuid,
  p_apply_email_discount boolean,
  p_idempotency_key uuid,
  p_expected_pricing_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $create$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_digits text := regexp_replace(coalesce(p_client_phone, ''), '\D', '', 'g');
  v_phone_bucket text;
  v_addon_ids uuid[] := coalesce(p_addon_service_ids, ARRAY[]::uuid[]);
  v_request_material jsonb;
  v_request_fingerprint text;
  v_quote jsonb;
  v_quote_fingerprint text;
  v_result jsonb;
  v_booking_id uuid;
  v_existing public.bookings%ROWTYPE;
  v_create_end timestamptz;
  v_trailing_buffer integer;
  v_addon_count integer;
  v_first_addon_id uuid;
  v_price integer;
  v_addon_price integer;
  v_original_price integer;
  v_subtotal integer;
  v_tax integer;
  v_promo_id uuid;
  v_promo_discount integer;
  v_email_discount integer;
  v_voucher_discount integer;
  v_pre_voucher_subtotal integer;
BEGIN
  IF v_role NOT IN ('anon', 'service_role') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  IF nullif(trim(coalesce(p_client_name, '')), '') IS NULL
     OR length(trim(p_client_name)) > 100
     OR p_client_name ~ '[<>{}=&;]'
     OR length(v_digits) < 7
     OR (
       nullif(trim(coalesce(p_client_email, '')), '') IS NOT NULL
       AND (
         length(trim(p_client_email)) > 254
         OR trim(p_client_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       )
     )
     OR (
       p_resource_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM public.salon_resources r
         WHERE r.id = p_resource_id
           AND r.salon_id = p_salon_id
           AND r.deleted_at IS NULL
       )
     ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_input');
  END IF;

  IF p_status IS DISTINCT FROM 'confirmed' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_status');
  END IF;

  IF p_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'missing_idempotency_key');
  END IF;

  IF p_expected_pricing_fingerprint IS NULL
     OR p_expected_pricing_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'missing_pricing_fingerprint');
  END IF;

  v_request_material := jsonb_build_object(
    'salon_id', p_salon_id,
    'service_id', p_service_id,
    'staff_id', p_staff_id,
    'client_name', trim(coalesce(p_client_name, '')),
    'client_phone', v_digits,
    'start_time_utc', p_start_time_utc,
    'end_time_utc', p_end_time_utc,
    'status', 'confirmed',
    'client_notes', nullif(trim(coalesce(p_client_notes, '')), ''),
    'addon_service_ids', to_jsonb(v_addon_ids),
    'client_email', nullif(lower(trim(coalesce(p_client_email, ''))), ''),
    'resource_id', p_resource_id,
    'combo_id', p_combo_id,
    'voucher_id', p_voucher_id,
    'apply_email_discount', coalesce(p_apply_email_discount, false),
    'expected_pricing_fingerprint', p_expected_pricing_fingerprint
  );
  v_request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_request_material::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-booking-idempotency:' ||
      coalesce(p_salon_id::text, 'missing') || ':' ||
      p_idempotency_key::text,
      0
    )
  );

  SELECT b.*
  INTO v_existing
  FROM public.bookings b
  WHERE b.salon_id = p_salon_id
    AND b.idempotency_key = p_idempotency_key
    AND b.group_id IS NULL
    AND b.recovered_from_booking_id IS NULL;

  IF FOUND THEN
    IF v_existing.public_booking_request_fingerprint
         IS DISTINCT FROM v_request_fingerprint
       OR v_existing.public_booking_pricing_fingerprint
         IS DISTINCT FROM p_expected_pricing_fingerprint
       OR pg_catalog.jsonb_typeof(v_existing.public_booking_pricing_snapshot)
         IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('success', false, 'code', 'idempotency_conflict');
    END IF;

    RETURN v_existing.public_booking_pricing_snapshot || jsonb_build_object(
      'success', true,
      'code', 'booked',
      'idempotent', true,
      'booking_id', v_existing.id,
      'start_time_utc', v_existing.start_time_utc,
      'end_time_utc', v_existing.end_time_utc
    );
  END IF;

  -- The accepted quote is intentionally obtainable only through the metered app
  -- route. A direct anon caller can otherwise submit a fake fingerprint and use
  -- pricing_changed as an unmetered quote oracle. Idempotent replay above remains
  -- cheap and does not consume this budget; every new anon attempt is claimed
  -- before the resolver can run or reveal current pricing. These are abuse-ledger
  -- writes only: a rejected attempt still performs zero booking/profile/voucher,
  -- promotion, add-on, notification, or other business-row writes.
  IF v_role = 'anon' THEN
    IF NOT public.rate_limit_hit(
      'public-booking-pricing-attempt:salon:' ||
        coalesce(p_salon_id::text, 'missing'),
      60, 300
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;

    v_phone_bucket := pg_catalog.md5(
      coalesce(p_salon_id::text, 'missing') || ':' || v_digits
    );
    IF NOT public.rate_limit_hit(
      'public-booking-pricing-attempt:phone:' || v_phone_bucket,
      30, 300
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;
  END IF;

  v_quote := public.resolve_public_booking_pricing(
    p_salon_id, p_service_id, p_staff_id, p_start_time_utc, p_end_time_utc,
    v_addon_ids, p_combo_id, p_voucher_id, p_client_phone, p_client_email,
    p_apply_email_discount, true
  );

  IF coalesce(v_quote->>'success', 'false') <> 'true' THEN
    RETURN v_quote;
  END IF;

  v_quote_fingerprint := v_quote->>'pricing_fingerprint';
  IF v_quote_fingerprint IS DISTINCT FROM p_expected_pricing_fingerprint THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'pricing_changed',
      'quote', v_quote
    );
  END IF;

  -- Pricing mismatch returns above after the dedicated abuse-ledger claim, but
  -- before the booking-create rate budget or any business-row write.
  IF v_role = 'anon' THEN
    IF NOT public.rate_limit_hit(
      'public-booking:salon:' || coalesce(p_salon_id::text, 'missing'),
      30, 600
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;

    v_phone_bucket := pg_catalog.md5(
      coalesce(p_salon_id::text, 'missing') || ':' || v_digits
    );
    IF NOT public.rate_limit_hit(
      'public-booking:phone:' || v_phone_bucket, 3, 900
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;
  END IF;

  v_trailing_buffer := coalesce((v_quote->>'trailing_buffer_minutes')::integer, 0);
  v_create_end := p_end_time_utc
    - pg_catalog.make_interval(mins => v_trailing_buffer);
  v_addon_count := pg_catalog.cardinality(v_addon_ids);
  v_first_addon_id := nullif(v_quote->>'first_addon_id', '')::uuid;
  v_price := (v_quote->>'price_cents')::integer;
  v_addon_price := (v_quote->>'addon_price_cents')::integer;
  v_original_price := (v_quote->>'original_price_cents')::integer;
  v_subtotal := (v_quote->>'subtotal_cents')::integer;
  v_tax := (v_quote->>'tax_cents')::integer;
  v_promo_id := nullif(v_quote->>'promo_id', '')::uuid;
  v_promo_discount := (v_quote->>'promo_discount_cents')::integer;
  v_email_discount := (v_quote->>'email_discount_cents')::integer;
  v_voucher_discount := (v_quote->>'voucher_discount_cents')::integer;
  v_pre_voucher_subtotal :=
    (v_quote->>'pre_voucher_subtotal_cents')::integer;

  BEGIN
    SELECT public.create_public_booking_unlimited_14(
      p_salon_id, p_service_id, p_staff_id, p_client_name, p_client_phone,
      p_start_time_utc, v_create_end, 'confirmed', v_price, p_client_notes,
      v_first_addon_id, v_addon_price, p_client_email, p_resource_id
    )
    INTO v_result;

    IF coalesce(v_result->>'success', 'false') <> 'true' THEN
      RETURN v_result;
    END IF;

    v_booking_id := nullif(v_result->>'booking_id', '')::uuid;
    IF v_booking_id IS NULL THEN
      RAISE EXCEPTION 'booking_id_missing_after_create';
    END IF;

    UPDATE public.bookings b
    SET end_time_utc = p_end_time_utc,
        price_cents = v_price,
        addon_price_cents = CASE
          WHEN v_addon_count > 0 THEN v_addon_price ELSE NULL
        END,
        promo_id = v_promo_id,
        original_price_cents = CASE
          WHEN v_promo_discount > 0
            OR v_email_discount > 0
            OR v_voucher_discount > 0
            THEN v_original_price
          ELSE NULL
        END,
        service_combo_id = p_combo_id,
        subtotal_cents = v_subtotal,
        tax_amount_cents = v_tax,
        idempotency_key = p_idempotency_key,
        public_booking_request_fingerprint = v_request_fingerprint,
        public_booking_pricing_fingerprint = v_quote_fingerprint,
        public_booking_pricing_snapshot = v_quote
    WHERE b.id = v_booking_id
      AND b.salon_id = p_salon_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'booking_not_found_after_create';
    END IF;

    IF v_addon_count > 0
       AND public.add_booking_addons(v_booking_id, v_addon_ids)
         <> v_addon_count THEN
      RAISE EXCEPTION 'booking_addons_not_persisted';
    END IF;

    IF v_email_discount > 0 THEN
      UPDATE public.client_profiles cp
      SET email_discount_claimed_at = transaction_timestamp(),
          updated_at = transaction_timestamp()
      FROM public.bookings b
      WHERE b.id = v_booking_id
        AND b.client_profile_id = cp.id
        AND cp.phone = v_digits
        AND cp.email_discount_claimed_at IS NULL;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'email_discount_claim_not_persisted';
      END IF;
    END IF;

    IF p_voucher_id IS NOT NULL THEN
      INSERT INTO public.voucher_redemptions (
        voucher_id, salon_id, booking_id, client_phone,
        discount_applied_cents, original_price_cents, final_price_cents
      ) VALUES (
        p_voucher_id, p_salon_id, v_booking_id, v_digits,
        v_voucher_discount, v_pre_voucher_subtotal, v_subtotal
      );
    END IF;

    RETURN v_quote || jsonb_build_object(
      'success', true,
      'code', 'booked',
      'idempotent', false,
      'booking_id', v_booking_id,
      'start_time_utc', p_start_time_utc,
      'end_time_utc', p_end_time_utc
    );
  EXCEPTION
    WHEN exclusion_violation THEN
      RETURN jsonb_build_object('success', false, 'code', 'slot_conflict');
    WHEN unique_violation THEN
      RETURN jsonb_build_object('success', false, 'code', 'duplicate_booking');
  END;
END;
$create$;

REVOKE ALL ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, text, uuid[], text, uuid, uuid, uuid, boolean, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, text, uuid[], text, uuid, uuid, uuid, boolean, uuid, text
) TO anon, service_role;

COMMENT ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, text, uuid[], text, uuid, uuid, uuid, boolean, uuid, text
) IS
  'Phase-A ID-only public booking boundary. Requires an accepted quote fingerprint and atomically persists the authoritative snapshot, incentives, voucher and add-ons.';

-- Phase A keeps the deployed legacy signature executable by anon while old and
-- new app assets overlap. The compatibility boundary no longer trusts either
-- caller-supplied money field: it resolves catalog/promotion pricing, active
-- staff, capability and timing through the same internal resolver as the new
-- path. It also takes the client/profile lock before rate-limit and staff locks,
-- matching the new path and preventing a legacy staff->profile lock inversion.
CREATE OR REPLACE FUNCTION public.create_public_booking(
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_client_name text,
  p_client_phone text,
  p_start_time_utc timestamptz,
  p_end_time_utc timestamptz,
  p_status text DEFAULT 'pending',
  p_price_cents integer DEFAULT NULL,
  p_client_notes text DEFAULT NULL,
  p_addon_service_id uuid DEFAULT NULL,
  p_addon_price_cents integer DEFAULT NULL,
  p_client_email text DEFAULT NULL,
  p_resource_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $legacy$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_digits text := pg_catalog.regexp_replace(
    coalesce(p_client_phone, ''), '\D', '', 'g'
  );
  v_phone_bucket text;
  v_profile_id uuid;
  v_addon_ids uuid[] := CASE
    WHEN p_addon_service_id IS NULL THEN ARRAY[]::uuid[]
    ELSE ARRAY[p_addon_service_id]::uuid[]
  END;
  v_quote jsonb;
  v_result jsonb;
  v_booking_id uuid;
  v_trailing_buffer integer;
  v_authoritative_end timestamptz := p_end_time_utc;
  v_create_end timestamptz;
BEGIN
  IF v_role NOT IN ('anon', 'service_role') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  IF length(v_digits) < 7 THEN
    RETURN jsonb_build_object('success', false, 'code', 'missing_phone');
  END IF;

  -- Advisory coverage protects the missing-profile case; FOR UPDATE protects an
  -- existing row. Both precede the legacy engine's staff/resource locks.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public-booking-client:' || v_digits, 0)
  );
  SELECT cp.id
  INTO v_profile_id
  FROM public.client_profiles cp
  WHERE cp.phone = v_digits
  FOR UPDATE;

  v_quote := public.resolve_public_booking_pricing(
    p_salon_id, p_service_id, p_staff_id, p_start_time_utc, p_end_time_utc,
    v_addon_ids, NULL, NULL, p_client_phone, p_client_email, false, false
  );
  -- Some deployed service-role callers still submit customer-facing duration
  -- without the catalog buffer. Canonicalize that legacy shape to the resolver's
  -- expected end instead of trusting the shorter interval or breaking rollout.
  IF v_quote->>'code' = 'invalid_time'
     AND nullif(v_quote->>'expected_end_time_utc', '') IS NOT NULL THEN
    BEGIN
      v_authoritative_end :=
        (v_quote->>'expected_end_time_utc')::timestamptz;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_time');
    END;
    v_quote := public.resolve_public_booking_pricing(
      p_salon_id, p_service_id, p_staff_id,
      p_start_time_utc, v_authoritative_end,
      v_addon_ids, NULL, NULL, p_client_phone, p_client_email, false, false
    );
  END IF;
  IF coalesce(v_quote->>'success', 'false') <> 'true' THEN
    RETURN v_quote;
  END IF;
  v_authoritative_end := (v_quote->>'end_time_utc')::timestamptz;

  IF v_role = 'anon' THEN
    IF NOT public.rate_limit_hit(
      'public-booking:salon:' || coalesce(p_salon_id::text, 'missing'),
      30, 600
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;

    v_phone_bucket := pg_catalog.md5(
      coalesce(p_salon_id::text, 'missing') || ':' || v_digits
    );
    IF NOT public.rate_limit_hit(
      'public-booking:phone:' || v_phone_bucket, 3, 900
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;
  END IF;

  v_trailing_buffer := coalesce(
    (v_quote->>'trailing_buffer_minutes')::integer, 0
  );
  v_create_end := v_authoritative_end
    - pg_catalog.make_interval(mins => v_trailing_buffer);

  BEGIN
    SELECT public.create_public_booking_unlimited_14(
      p_salon_id, p_service_id, p_staff_id, p_client_name, p_client_phone,
      p_start_time_utc, v_create_end, 'confirmed',
      (v_quote->>'price_cents')::integer, p_client_notes,
      nullif(v_quote->>'first_addon_id', '')::uuid,
      (v_quote->>'addon_price_cents')::integer,
      p_client_email, p_resource_id
    )
    INTO v_result;

    IF coalesce(v_result->>'success', 'false') <> 'true' THEN
      RETURN v_result;
    END IF;

    v_booking_id := nullif(v_result->>'booking_id', '')::uuid;
    UPDATE public.bookings b
    SET end_time_utc = v_authoritative_end
    WHERE b.id = v_booking_id
      AND b.salon_id = p_salon_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'booking_not_found_after_create';
    END IF;

    RETURN pg_catalog.jsonb_set(
      v_result,
      '{end_time_utc}',
      pg_catalog.to_jsonb(v_authoritative_end),
      true
    );
  EXCEPTION
    WHEN exclusion_violation THEN
      RETURN jsonb_build_object('success', false, 'code', 'slot_conflict');
  END;
END;
$legacy$;

REVOKE ALL ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, integer, text, uuid, integer, text, uuid
) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, integer, text, uuid, integer, text, uuid
) TO anon, service_role;

DO $proof$
DECLARE
  v_resolver regprocedure := pg_catalog.to_regprocedure(
    'public.resolve_public_booking_pricing(uuid,uuid,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,text,text,boolean,boolean)'
  );
  v_quote regprocedure := pg_catalog.to_regprocedure(
    'public.quote_public_booking(uuid,uuid,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,text,text,boolean)'
  );
  v_create regprocedure := pg_catalog.to_regprocedure(
    'public.create_public_booking(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text)'
  );
  v_legacy regprocedure := pg_catalog.to_regprocedure(
    'public.create_public_booking(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid)'
  );
  v_owner_claim regprocedure := pg_catalog.to_regprocedure(
    'public.claim_owner_booking_notification(uuid,uuid,text,text,text)'
  );
  v_owner_complete regprocedure := pg_catalog.to_regprocedure(
    'public.complete_owner_booking_notification(uuid,text,text,text)'
  );
  v_target record;
  v_public_execute boolean;
  v_def text;
  v_compact_def text;
BEGIN
  IF v_resolver IS NULL OR v_quote IS NULL OR v_create IS NULL
     OR v_legacy IS NULL OR v_owner_claim IS NULL
     OR v_owner_complete IS NULL THEN
    RAISE EXCEPTION 'public booking pricing or owner claim signature missing';
  END IF;

  FOR v_target IN
    SELECT *
    FROM (
      VALUES
        (v_resolver, false, false, true, 'resolver'),
        (v_quote, false, false, true, 'quote'),
        (v_create, true, false, true, 'create'),
        (v_legacy, true, false, true, 'legacy phase A'),
        (v_owner_claim, false, false, true, 'owner claim'),
        (v_owner_complete, false, false, true, 'owner complete')
    ) expected(function_oid, allow_anon, allow_authenticated, allow_service_role, label)
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) acl
      WHERE p.oid = v_target.function_oid::oid
        AND acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE'
    )
    INTO v_public_execute;

    IF v_public_execute
       OR pg_catalog.has_function_privilege(
         'anon', v_target.function_oid, 'EXECUTE'
       ) IS DISTINCT FROM v_target.allow_anon
       OR pg_catalog.has_function_privilege(
         'authenticated', v_target.function_oid, 'EXECUTE'
       ) IS DISTINCT FROM v_target.allow_authenticated
       OR pg_catalog.has_function_privilege(
         'service_role', v_target.function_oid, 'EXECUTE'
       ) IS DISTINCT FROM v_target.allow_service_role THEN
      RAISE EXCEPTION 'function ACL mismatch: %', v_target.label;
    END IF;

    SELECT pg_catalog.pg_get_functiondef(v_target.function_oid::oid)
    INTO v_def;
    IF position('SECURITY DEFINER' IN v_def) = 0
       OR position('SET search_path TO ''''' IN v_def) = 0 THEN
      RAISE EXCEPTION 'function hardening mismatch: %', v_target.label;
    END IF;
  END LOOP;

  SELECT pg_catalog.pg_get_functiondef(v_create::oid)
  INTO v_def;
  IF position('public-booking-pricing-attempt:salon:' IN v_def) = 0
     OR position('public-booking-pricing-attempt:phone:' IN v_def) = 0
     OR position('public-booking-pricing-attempt:phone:' IN v_def) >
        position('public.resolve_public_booking_pricing' IN v_def) THEN
    RAISE EXCEPTION 'create abuse-rate boundary mismatch';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_legacy::oid)
  INTO v_def;
  v_compact_def := pg_catalog.regexp_replace(v_def, '\s+', '', 'g');
  IF position('public.resolve_public_booking_pricing' IN v_def) = 0
     OR position('public-booking-client:' IN v_def) = 0
     OR position(
       '(v_quote->>''price_cents'')::integer' IN v_compact_def
     ) = 0
     OR position('p_price_cents,p_client_notes' IN v_compact_def) > 0
     OR position('p_addon_price_cents,p_client_email' IN v_compact_def) > 0 THEN
    RAISE EXCEPTION 'legacy Phase-A hardening mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.owner_booking_notification_claims'::regclass
      AND c.conname = 'owner_booking_notification_claims_sent_provider_check'
      AND position(
        'provider_message_id' IN pg_catalog.pg_get_constraintdef(c.oid)
      ) > 0
      AND position('sent' IN pg_catalog.pg_get_constraintdef(c.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'owner sent notification provider evidence mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.booking_notifications'::regclass
      AND c.conname = 'booking_notifications_confirmation_sent_receipt_check'
      AND c.convalidated IS FALSE
      AND position(
        'notification_type' IN pg_catalog.pg_get_constraintdef(c.oid)
      ) > 0
      AND position('status' IN pg_catalog.pg_get_constraintdef(c.oid)) > 0
      AND position(
        'twilio_message_sid' IN pg_catalog.pg_get_constraintdef(c.oid)
      ) > 0
  ) THEN
    RAISE EXCEPTION 'customer confirmation sent provider evidence mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    WHERE i.indexrelid = 'public.idx_bookings_public_idempotency_once'::regclass
      AND i.indrelid = 'public.bookings'::regclass
      AND i.indisunique AND i.indisvalid
      AND i.indnkeyatts = 2
      AND i.indkey::text = pg_catalog.format(
        '%s %s',
        (SELECT a.attnum FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = 'public.bookings'::regclass
           AND a.attname = 'salon_id'),
        (SELECT a.attnum FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = 'public.bookings'::regclass
           AND a.attname = 'idempotency_key')
      )
      AND pg_catalog.pg_get_expr(i.indpred, i.indrelid) =
        '((idempotency_key IS NOT NULL) AND (group_id IS NULL) AND (recovered_from_booking_id IS NULL))'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    WHERE i.indexrelid =
      'public.idx_voucher_redemptions_booking_once'::regclass
      AND i.indrelid = 'public.voucher_redemptions'::regclass
      AND i.indisunique AND i.indisvalid
      AND i.indnkeyatts = 2
      AND i.indkey::text = pg_catalog.format(
        '%s %s',
        (SELECT a.attnum FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = 'public.voucher_redemptions'::regclass
           AND a.attname = 'voucher_id'),
        (SELECT a.attnum FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = 'public.voucher_redemptions'::regclass
           AND a.attname = 'booking_id')
      )
      AND pg_catalog.pg_get_expr(i.indpred, i.indrelid) =
        '(booking_id IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION 'public booking unique invariant missing';
  END IF;

  IF NOT (SELECT c.relrowsecurity
          FROM pg_catalog.pg_class c
          WHERE c.oid =
            'public.owner_booking_notification_claims'::regclass)
     OR pg_catalog.has_table_privilege(
       'anon', 'public.owner_booking_notification_claims',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.owner_booking_notification_claims',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.owner_booking_notification_claims',
       'SELECT,INSERT,UPDATE,DELETE'
     ) THEN
    RAISE EXCEPTION 'owner booking notification claim boundary mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid =
        'public.owner_booking_notification_claims'::regclass
      AND c.conname = 'owner_booking_notification_claims_once'
      AND pg_catalog.pg_get_constraintdef(c.oid) =
        'UNIQUE (booking_id, event_type, recipient_identity, event_occurrence_key)'
  ) THEN
    RAISE EXCEPTION 'owner booking notification occurrence key mismatch';
  END IF;
END;
$proof$;

RESET statement_timeout;
RESET lock_timeout;

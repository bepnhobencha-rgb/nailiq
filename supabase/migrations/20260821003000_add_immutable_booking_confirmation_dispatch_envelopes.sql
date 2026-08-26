-- MQA-0157: preserve the exact provider dispatch material for one bounded retry.
--
-- This is intentionally additive and default-inert.  No scheduler is enabled and
-- no existing confirmation is backfilled.  The raw envelope is API-inaccessible
-- to browser roles and is deleted as soon as its notification becomes terminal.

CREATE TABLE public.booking_confirmation_dispatch_envelopes (
  claim_id uuid PRIMARY KEY
    REFERENCES public.booking_notifications(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  contract_version smallint NOT NULL DEFAULT 1 CHECK (contract_version = 1),
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  recipient_fingerprint text NOT NULL CHECK (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
  dispatch_envelope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT booking_confirmation_dispatch_envelope_size_check
    CHECK (octet_length(dispatch_envelope) BETWEEN 1 AND 262144)
);

COMMENT ON TABLE public.booking_confirmation_dispatch_envelopes IS
  'Ephemeral, immutable, service-only exact SMS/email confirmation provider envelope. Deleted on every terminal delivery outcome.';
COMMENT ON COLUMN public.booking_confirmation_dispatch_envelopes.dispatch_envelope IS
  'Exact UTF-8 JSON bytes whose SHA-256 is payload_fingerprint. Contains delivery PII; never grant to browser roles.';

CREATE INDEX booking_confirmation_dispatch_envelopes_salon_created_idx
  ON public.booking_confirmation_dispatch_envelopes (salon_id, created_at, claim_id);

ALTER TABLE public.booking_confirmation_dispatch_envelopes ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.booking_confirmation_dispatch_envelopes
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.booking_confirmation_dispatch_envelopes TO service_role;

CREATE POLICY "deny browser access to confirmation dispatch envelopes"
  ON public.booking_confirmation_dispatch_envelopes
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE FUNCTION public.prevent_booking_confirmation_dispatch_envelope_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $guard$
BEGIN
  RAISE EXCEPTION 'booking confirmation dispatch envelopes are immutable'
    USING ERRCODE = 'check_violation';
END;
$guard$;

CREATE TRIGGER prevent_booking_confirmation_dispatch_envelope_update
BEFORE UPDATE ON public.booking_confirmation_dispatch_envelopes
FOR EACH ROW EXECUTE FUNCTION public.prevent_booking_confirmation_dispatch_envelope_update();

-- The prior provider-material-free claim remains available only as a private
-- implementation helper.  Its original public signature is recreated below as
-- a fail-closed compatibility stub, so stale callers cannot create unsafe work.
ALTER FUNCTION public.claim_booking_confirmation_delivery(uuid, uuid, text, text, text)
  RENAME TO claim_booking_confirmation_delivery_without_envelope_legacy;
REVOKE ALL ON FUNCTION public.claim_booking_confirmation_delivery_without_envelope_legacy(uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.claim_booking_confirmation_delivery(
  p_salon_id uuid,
  p_booking_id uuid,
  p_channel text,
  p_payload_fingerprint text,
  p_recipient_fingerprint text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $legacy_stub$
  SELECT jsonb_build_object(
    'success', false,
    'code', 'dispatch_envelope_required',
    'claimed', false
  );
$legacy_stub$;

CREATE FUNCTION public.claim_booking_confirmation_delivery(
  p_salon_id uuid,
  p_booking_id uuid,
  p_channel text,
  p_payload_fingerprint text,
  p_recipient_fingerprint text,
  p_dispatch_envelope text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $claim$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_existing public.booking_notifications%ROWTYPE;
  v_stored public.booking_confirmation_dispatch_envelopes%ROWTYPE;
  v_envelope jsonb;
  v_item jsonb;
  v_recipient text;
  v_envelope_recipient text;
  v_expected_payload_fingerprint text;
  v_expected_recipient_fingerprint text;
  v_result jsonb;
  v_claim_id uuid;
  v_count integer;
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL
     OR p_channel NOT IN ('sms', 'email')
     OR coalesce(p_payload_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_recipient_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR p_dispatch_envelope IS NULL
     OR octet_length(p_dispatch_envelope) NOT BETWEEN 1 AND 262144 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_dispatch_envelope', 'claimed', false);
  END IF;

  v_expected_payload_fingerprint := encode(
    extensions.digest(pg_catalog.convert_to(p_dispatch_envelope, 'UTF8'), 'sha256'), 'hex'
  );
  IF p_payload_fingerprint <> v_expected_payload_fingerprint THEN
    RETURN jsonb_build_object('success', false, 'code', 'payload_fingerprint_mismatch', 'claimed', false);
  END IF;

  BEGIN
    v_envelope := p_dispatch_envelope::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_dispatch_envelope', 'claimed', false);
  END;
  IF jsonb_typeof(v_envelope) <> 'object'
     OR jsonb_typeof(v_envelope->'v') <> 'number'
     OR v_envelope->>'v' <> '1'
     OR v_envelope->>'channel' IS DISTINCT FROM p_channel
     OR v_envelope->>'salonId' IS DISTINCT FROM p_salon_id::text THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_dispatch_envelope', 'claimed', false);
  END IF;

  SELECT count(*) INTO v_count FROM jsonb_object_keys(v_envelope);
  IF p_channel = 'sms' THEN
    IF v_count <> 8 OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(v_envelope) AS k(key)
      WHERE k.key NOT IN ('v','channel','salonId','to','body','statusCallbackUrl','salonIsTest','lang')
    ) OR jsonb_typeof(v_envelope->'to') <> 'string'
      OR length(v_envelope->>'to') NOT BETWEEN 1 AND 80
      OR jsonb_typeof(v_envelope->'body') <> 'string'
      OR length(v_envelope->>'body') NOT BETWEEN 1 AND 4000
      OR jsonb_typeof(v_envelope->'statusCallbackUrl') <> 'string'
      OR length(v_envelope->>'statusCallbackUrl') NOT BETWEEN 1 AND 2048
      OR v_envelope->>'statusCallbackUrl' !~ '^https://[^[:space:][:cntrl:]]+$'
      OR jsonb_typeof(v_envelope->'salonIsTest') <> 'boolean'
      OR jsonb_typeof(v_envelope->'lang') <> 'string'
      OR v_envelope->>'lang' NOT IN ('en', 'vi') THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_dispatch_envelope', 'claimed', false);
    END IF;
  ELSE
    IF v_count <> 10 OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(v_envelope) AS k(key)
      WHERE k.key NOT IN ('v','channel','salonId','to','from','subject','html','headers','replyTo','attachments')
    ) OR jsonb_typeof(v_envelope->'to') <> 'string'
      OR length(v_envelope->>'to') NOT BETWEEN 3 AND 320
      OR v_envelope->>'to' !~ '@'
      OR v_envelope->>'to' ~ '[[:cntrl:]]'
      OR jsonb_typeof(v_envelope->'from') <> 'string'
      OR length(v_envelope->>'from') NOT BETWEEN 1 AND 320
      OR v_envelope->>'from' ~ '[[:cntrl:]]'
      OR jsonb_typeof(v_envelope->'subject') <> 'string'
      OR length(v_envelope->>'subject') NOT BETWEEN 1 AND 998
      OR v_envelope->>'subject' ~ '[\r\n]'
      OR jsonb_typeof(v_envelope->'html') <> 'string'
      OR length(v_envelope->>'html') NOT BETWEEN 1 AND 240000
      OR jsonb_typeof(v_envelope->'headers') <> 'object'
      OR jsonb_typeof(v_envelope->'attachments') <> 'array'
      OR jsonb_array_length(v_envelope->'attachments') > 3
      OR NOT (
        jsonb_typeof(v_envelope->'replyTo') = 'null'
        OR (
          jsonb_typeof(v_envelope->'replyTo') = 'string'
          AND length(v_envelope->>'replyTo') BETWEEN 3 AND 320
          AND v_envelope->>'replyTo' ~ '@'
          AND v_envelope->>'replyTo' !~ '[[:cntrl:]]'
        )
      ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_dispatch_envelope', 'claimed', false);
    END IF;

    SELECT count(*) INTO v_count FROM jsonb_object_keys(v_envelope->'headers');
    IF v_count > 20 OR EXISTS (
      SELECT 1 FROM jsonb_each(v_envelope->'headers') AS h(key, value)
      WHERE h.key !~ '^[A-Za-z0-9-]{1,80}$'
         OR jsonb_typeof(h.value) <> 'string'
         OR length(h.value #>> '{}') NOT BETWEEN 1 AND 2048
         OR (h.value #>> '{}') ~ '[\r\n]'
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_dispatch_envelope', 'claimed', false);
    END IF;

    FOR v_item IN SELECT value FROM jsonb_array_elements(v_envelope->'attachments')
    LOOP
      IF jsonb_typeof(v_item) <> 'object' OR (
           SELECT count(*) FROM jsonb_object_keys(v_item)
         ) <> 3 OR EXISTS (
           SELECT 1 FROM jsonb_object_keys(v_item) AS k(key)
           WHERE k.key NOT IN ('filename','content','contentType')
         ) OR jsonb_typeof(v_item->'filename') <> 'string'
           OR length(v_item->>'filename') NOT BETWEEN 1 AND 255
           OR v_item->>'filename' ~ '[[:cntrl:]]'
           OR jsonb_typeof(v_item->'content') <> 'string'
           OR length(v_item->>'content') NOT BETWEEN 1 AND 128000
           OR v_item->>'content' !~ '^[A-Za-z0-9+/]*={0,2}$'
           OR length(v_item->>'content') % 4 <> 0
           OR jsonb_typeof(v_item->'contentType') <> 'string'
           OR length(v_item->>'contentType') NOT BETWEEN 1 AND 255
           OR v_item->>'contentType' ~ '[[:cntrl:]]' THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_dispatch_envelope', 'claimed', false);
      END IF;
    END LOOP;
  END IF;

  SELECT b.* INTO v_booking
  FROM public.bookings b
  WHERE b.id = p_booking_id AND b.salon_id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'booking_not_found', 'claimed', false);
  END IF;

  v_recipient := CASE p_channel
    WHEN 'sms' THEN nullif(regexp_replace(coalesce(v_booking.client_phone, ''), '\D', '', 'g'), '')
    ELSE nullif(lower(trim(coalesce(v_booking.client_email, ''))), '')
  END;
  v_envelope_recipient := CASE p_channel
    WHEN 'sms' THEN nullif(regexp_replace(coalesce(v_envelope->>'to', ''), '\D', '', 'g'), '')
    ELSE nullif(lower(trim(coalesce(v_envelope->>'to', ''))), '')
  END;
  IF v_recipient IS NULL OR v_envelope_recipient IS DISTINCT FROM v_recipient THEN
    RETURN jsonb_build_object('success', false, 'code', 'recipient_mismatch', 'claimed', false);
  END IF;
  v_expected_recipient_fingerprint := encode(
    extensions.digest(pg_catalog.convert_to(v_recipient, 'UTF8'), 'sha256'), 'hex'
  );
  IF p_recipient_fingerprint <> v_expected_recipient_fingerprint THEN
    RETURN jsonb_build_object('success', false, 'code', 'recipient_fingerprint_mismatch', 'claimed', false);
  END IF;

  -- Never reconstruct a provider payload for a previously claimed legacy row.
  -- Such rows are intentionally left for the stale reconciler to terminalize.
  SELECT n.* INTO v_existing
  FROM public.booking_notifications n
  WHERE n.booking_id = p_booking_id
    AND n.notification_type = 'booking_confirmation'
    AND n.channel = p_channel
  FOR UPDATE;
  IF FOUND AND v_existing.attempt_token IS NOT NULL
     AND (
       v_existing.status = 'sending'
       OR (
         v_existing.status = 'failed'
         AND v_existing.failure_disposition = 'retryable_pre_acceptance'
         AND v_existing.next_attempt_at IS NOT NULL
       )
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.booking_confirmation_dispatch_envelopes e
       WHERE e.claim_id = v_existing.id
     ) THEN
    RETURN jsonb_build_object(
      'success', false, 'code', 'dispatch_envelope_missing', 'claimed', false,
      'claim_id', v_existing.id
    );
  END IF;

  v_result := public.claim_booking_confirmation_delivery_without_envelope_legacy(
    p_salon_id, p_booking_id, p_channel,
    p_payload_fingerprint, p_recipient_fingerprint
  );
  v_claim_id := nullif(v_result->>'claim_id', '')::uuid;

  IF v_claim_id IS NOT NULL AND coalesce((v_result->>'claimed')::boolean, false) THEN
    INSERT INTO public.booking_confirmation_dispatch_envelopes (
      claim_id, booking_id, salon_id, channel, contract_version,
      payload_fingerprint, recipient_fingerprint, dispatch_envelope
    ) VALUES (
      v_claim_id, p_booking_id, p_salon_id, p_channel, 1,
      v_expected_payload_fingerprint, v_expected_recipient_fingerprint,
      p_dispatch_envelope
    ) ON CONFLICT (claim_id) DO NOTHING;
  END IF;

  IF v_claim_id IS NOT NULL THEN
    SELECT e.* INTO v_stored
    FROM public.booking_confirmation_dispatch_envelopes e
    WHERE e.claim_id = v_claim_id;
    IF FOUND AND (
      v_stored.booking_id <> p_booking_id
      OR v_stored.salon_id <> p_salon_id
      OR v_stored.channel <> p_channel
      OR v_stored.payload_fingerprint <> v_expected_payload_fingerprint
      OR v_stored.recipient_fingerprint <> v_expected_recipient_fingerprint
      OR v_stored.dispatch_envelope <> p_dispatch_envelope
    ) THEN
      RAISE EXCEPTION 'confirmation envelope material conflict'
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  RETURN v_result;
END;
$claim$;

-- Delete sensitive dispatch material at every terminal transition.  The only
-- states allowed to retain it are an active provider attempt and a scheduled,
-- explicitly pre-acceptance retry.
CREATE FUNCTION public.cleanup_terminal_booking_confirmation_dispatch_envelope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $cleanup$
BEGIN
  IF NEW.notification_type = 'booking_confirmation'
     AND NEW.attempt_token IS NOT NULL
     AND NOT (
       NEW.status = 'sending'
       OR (
         NEW.status = 'failed'
         AND NEW.failure_disposition = 'retryable_pre_acceptance'
         AND NEW.attempt_count < 2
         AND NEW.next_attempt_at IS NOT NULL
       )
     ) THEN
    DELETE FROM public.booking_confirmation_dispatch_envelopes e
    WHERE e.claim_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$cleanup$;

CREATE TRIGGER cleanup_terminal_booking_confirmation_dispatch_envelope
AFTER UPDATE OF status, failure_disposition, next_attempt_at, attempt_count
ON public.booking_notifications
FOR EACH ROW EXECUTE FUNCTION public.cleanup_terminal_booking_confirmation_dispatch_envelope();

-- As with claim, the old lease is retained only as a private state-machine
-- helper.  The service-visible replacement enriches valid leases with the exact
-- raw envelope and silently terminalizes any unsafe legacy/corrupt lease.
ALTER FUNCTION public.lease_due_booking_confirmation_retries(integer)
  RENAME TO lease_due_booking_confirmation_retries_without_envelope_legacy;
REVOKE ALL ON FUNCTION public.lease_due_booking_confirmation_retries_without_envelope_legacy(integer)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.lease_due_booking_confirmation_retries(p_limit integer)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $lease$
DECLARE
  v_lease jsonb;
  v_stored public.booking_confirmation_dispatch_envelopes%ROWTYPE;
  v_computed_payload_fingerprint text;
BEGIN
  FOR v_lease IN
    SELECT value
    FROM public.lease_due_booking_confirmation_retries_without_envelope_legacy(p_limit) AS q(value)
  LOOP
    SELECT e.* INTO v_stored
    FROM public.booking_confirmation_dispatch_envelopes e
    WHERE e.claim_id = (v_lease->>'claim_id')::uuid;

    IF FOUND THEN
      v_computed_payload_fingerprint := encode(
        extensions.digest(pg_catalog.convert_to(v_stored.dispatch_envelope, 'UTF8'), 'sha256'), 'hex'
      );
    END IF;

    IF NOT FOUND
       OR v_stored.booking_id::text IS DISTINCT FROM v_lease->>'booking_id'
       OR v_stored.salon_id::text IS DISTINCT FROM v_lease->>'salon_id'
       OR v_stored.channel IS DISTINCT FROM v_lease->>'channel'
       OR v_stored.payload_fingerprint IS DISTINCT FROM v_computed_payload_fingerprint THEN
      PERFORM public.complete_booking_confirmation_delivery(
        (v_lease->>'claim_id')::uuid,
        (v_lease->>'attempt_token')::uuid,
        'failed', NULL, 'material_changed', 'permanent'
      );
      CONTINUE;
    END IF;

    RETURN NEXT v_lease || jsonb_build_object(
      'payload_fingerprint', v_stored.payload_fingerprint,
      'recipient_fingerprint', v_stored.recipient_fingerprint,
      'dispatch_envelope', v_stored.dispatch_envelope
    );
  END LOOP;
END;
$lease$;

REVOKE ALL ON FUNCTION public.prevent_booking_confirmation_dispatch_envelope_update()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cleanup_terminal_booking_confirmation_dispatch_envelope()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_booking_confirmation_delivery(uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_booking_confirmation_delivery(uuid, uuid, text, text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.claim_booking_confirmation_delivery(uuid, uuid, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_booking_confirmation_delivery(uuid, uuid, text, text, text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.lease_due_booking_confirmation_retries(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lease_due_booking_confirmation_retries(integer)
  TO service_role;

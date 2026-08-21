\set ON_ERROR_STOP on

DO $check$
DECLARE
  v_resolver regprocedure := to_regprocedure(
    'public.resolve_public_booking_pricing(uuid,uuid,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,text,text,boolean,boolean)'
  );
  v_quote regprocedure := to_regprocedure(
    'public.quote_public_booking(uuid,uuid,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,text,text,boolean)'
  );
  v_create regprocedure := to_regprocedure(
    'public.create_public_booking(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text)'
  );
  v_legacy regprocedure := to_regprocedure(
    'public.create_public_booking(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid)'
  );
  v_claim regprocedure := to_regprocedure(
    'public.claim_owner_booking_notification(uuid,uuid,text,text,text)'
  );
  v_complete regprocedure := to_regprocedure(
    'public.complete_owner_booking_notification(uuid,text,text,text)'
  );
  v_target record;
  v_def text;
  v_compact_def text;
  v_status_check text;
  v_public_execute boolean;
BEGIN
  IF v_resolver IS NULL OR v_quote IS NULL OR v_create IS NULL
     OR v_legacy IS NULL OR v_claim IS NULL OR v_complete IS NULL THEN
    RAISE EXCEPTION 'public booking pricing signature is missing';
  END IF;

  FOR v_target IN
    SELECT * FROM (
      VALUES
        (v_resolver, false, false, true, 'resolver'),
        (v_quote, false, false, true, 'quote'),
        (v_create, true, false, true, 'create'),
        (v_legacy, true, false, true, 'legacy phase A'),
        (v_claim, false, false, true, 'owner claim'),
        (v_complete, false, false, true, 'owner complete')
    ) expected(fn, anon_ok, authenticated_ok, service_ok, label)
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        coalesce(p.proacl, acldefault('f', p.proowner))
      ) acl
      WHERE p.oid = v_target.fn::oid
        AND acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE'
    ) INTO v_public_execute;

    IF v_public_execute
       OR has_function_privilege('anon', v_target.fn, 'EXECUTE')
          IS DISTINCT FROM v_target.anon_ok
       OR has_function_privilege('authenticated', v_target.fn, 'EXECUTE')
          IS DISTINCT FROM v_target.authenticated_ok
       OR has_function_privilege('service_role', v_target.fn, 'EXECUTE')
          IS DISTINCT FROM v_target.service_ok THEN
      RAISE EXCEPTION 'function ACL mismatch: %', v_target.label;
    END IF;

    SELECT pg_get_functiondef(v_target.fn::oid) INTO v_def;
    IF position('SECURITY DEFINER' IN v_def) = 0
       OR position('SET search_path TO ''''' IN v_def) = 0 THEN
      RAISE EXCEPTION 'function hardening mismatch: %', v_target.label;
    END IF;
  END LOOP;

  SELECT pg_get_functiondef(v_create::oid) INTO v_def;
  IF position('p_status IS DISTINCT FROM ''confirmed''' IN v_def) = 0
     OR position('public.resolve_public_booking_pricing' IN v_def) = 0
     OR position('''pricing_changed''' IN v_def) = 0
     OR position('public-booking-pricing-attempt:salon:' IN v_def) = 0
     OR position('public-booking-pricing-attempt:phone:' IN v_def) = 0
     OR position('public-booking-pricing-attempt:phone:' IN v_def) >
        position('public.resolve_public_booking_pricing' IN v_def)
     OR position('public_booking_request_fingerprint' IN v_def) = 0
     OR position('public_booking_pricing_snapshot' IN v_def) = 0 THEN
    RAISE EXCEPTION 'create RPC lost a server-authoritative invariant';
  END IF;

  SELECT pg_get_functiondef(v_legacy::oid) INTO v_def;
  v_compact_def := regexp_replace(v_def, '\s+', '', 'g');
  IF position('public.resolve_public_booking_pricing' IN v_def) = 0
     OR position('public-booking-client:' IN v_def) = 0
     OR position('(v_quote->>''price_cents'')::integer' IN v_compact_def) = 0
     OR position('p_price_cents,p_client_notes' IN v_compact_def) > 0
     OR position('p_addon_price_cents,p_client_email' IN v_compact_def) > 0 THEN
    RAISE EXCEPTION 'legacy Phase-A hardening invariant is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = 'public.idx_bookings_public_idempotency_once'::regclass
      AND indrelid = 'public.bookings'::regclass
      AND indisunique AND indisvalid
      AND indnkeyatts = 2
      AND indkey::text = format(
        '%s %s',
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.bookings'::regclass
           AND attname = 'salon_id'),
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.bookings'::regclass
           AND attname = 'idempotency_key')
      )
      AND pg_get_expr(indpred, indrelid) =
        '((idempotency_key IS NOT NULL) AND (group_id IS NULL) AND (recovered_from_booking_id IS NULL))'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = 'public.idx_voucher_redemptions_booking_once'::regclass
      AND indrelid = 'public.voucher_redemptions'::regclass
      AND indisunique AND indisvalid
      AND indnkeyatts = 2
      AND indkey::text = format(
        '%s %s',
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.voucher_redemptions'::regclass
           AND attname = 'voucher_id'),
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.voucher_redemptions'::regclass
           AND attname = 'booking_id')
      )
      AND pg_get_expr(indpred, indrelid) = '(booking_id IS NOT NULL)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = 'public.booking_notifications_confirmation_once'::regclass
      AND indisunique AND indisvalid
  ) THEN
    RAISE EXCEPTION 'booking or notification uniqueness invariant is missing';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class
          WHERE oid = 'public.owner_booking_notification_claims'::regclass)
     OR has_table_privilege(
       'anon', 'public.owner_booking_notification_claims',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     OR has_table_privilege(
       'authenticated', 'public.owner_booking_notification_claims',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     OR NOT has_table_privilege(
       'service_role', 'public.owner_booking_notification_claims',
       'SELECT,INSERT,UPDATE,DELETE'
     ) THEN
    RAISE EXCEPTION 'owner notification claim table boundary mismatch';
  END IF;

  SELECT pg_get_constraintdef(c.oid)
  INTO v_status_check
  FROM pg_constraint c
  WHERE c.conrelid = 'public.owner_booking_notification_claims'::regclass
    AND c.conname = 'owner_booking_notification_claims_status_check';

  IF v_status_check IS NULL
     OR position('sending' IN v_status_check) = 0
     OR position('sent' IN v_status_check) = 0
     OR position('failed' IN v_status_check) = 0
     OR position('unknown' IN v_status_check) = 0
     OR position('suppressed' IN v_status_check) = 0 THEN
    RAISE EXCEPTION 'owner notification claim status taxonomy mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.owner_booking_notification_claims'::regclass
      AND c.conname = 'owner_booking_notification_claims_once'
      AND pg_get_constraintdef(c.oid) =
        'UNIQUE (booking_id, event_type, recipient_identity, event_occurrence_key)'
  ) THEN
    RAISE EXCEPTION 'owner notification occurrence uniqueness mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.owner_booking_notification_claims'::regclass
      AND c.conname = 'owner_booking_notification_claims_sent_provider_check'
      AND position('provider_message_id' IN pg_get_constraintdef(c.oid)) > 0
      AND position('sent' IN pg_get_constraintdef(c.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'owner sent notification provider evidence mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.booking_notifications'::regclass
      AND c.conname = 'booking_notifications_confirmation_sent_receipt_check'
      AND c.convalidated IS FALSE
      AND position('notification_type' IN pg_get_constraintdef(c.oid)) > 0
      AND position('status' IN pg_get_constraintdef(c.oid)) > 0
      AND position('twilio_message_sid' IN pg_get_constraintdef(c.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'customer confirmation sent provider evidence mismatch';
  END IF;

  -- The customer confirmation log intentionally remains an open text taxonomy;
  -- ensure no inherited CHECK silently rejects the truthful suppressed state.
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.booking_notifications'::regclass
      AND c.contype = 'c'
      AND c.conname <> 'booking_notifications_confirmation_sent_receipt_check'
      AND pg_get_constraintdef(c.oid) ILIKE '%status%'
      AND pg_get_constraintdef(c.oid) NOT ILIKE '%suppressed%'
  ) THEN
    RAISE EXCEPTION 'booking_notifications cannot record suppressed';
  END IF;
END
$check$;

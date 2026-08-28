\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.service_categories(slug, name_en, name_vi)
VALUES ('owner-delivery-truth-qa', 'Owner delivery truth QA', 'Owner delivery truth QA')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.salons(id, slug, name, phone, timezone)
VALUES (
  'd8100000-0000-4000-8000-000000000001',
  'owner-delivery-truth-qa',
  'Owner Delivery Truth QA',
  '+16045550810',
  'America/Vancouver'
);

INSERT INTO public.services(id, salon_id, name, price_cents, duration_minutes, category)
VALUES (
  'd8100000-0000-4000-8000-000000000002',
  'd8100000-0000-4000-8000-000000000001',
  'Delivery truth service',
  4500,
  45,
  'owner-delivery-truth-qa'
);

INSERT INTO public.staff(id, salon_id, name, status)
VALUES (
  'd8100000-0000-4000-8000-000000000003',
  'd8100000-0000-4000-8000-000000000001',
  'Delivery truth staff',
  'active'
);

INSERT INTO public.bookings(
  id, salon_id, service_id, staff_id, client_name, client_email,
  start_time_utc, end_time_utc, status, price_cents
) VALUES
  (
    'd8100000-0000-4000-8000-000000000010',
    'd8100000-0000-4000-8000-000000000001',
    'd8100000-0000-4000-8000-000000000002',
    'd8100000-0000-4000-8000-000000000003',
    'Delivery truth guest 1',
    'guest-one@example.invalid',
    transaction_timestamp() + interval '3 days',
    transaction_timestamp() + interval '3 days 45 minutes',
    'confirmed',
    4500
  ),
  (
    'd8100000-0000-4000-8000-000000000011',
    'd8100000-0000-4000-8000-000000000001',
    'd8100000-0000-4000-8000-000000000002',
    'd8100000-0000-4000-8000-000000000003',
    'Delivery truth guest 2',
    'guest-two@example.invalid',
    transaction_timestamp() + interval '4 days',
    transaction_timestamp() + interval '4 days 45 minutes',
    'confirmed',
    4500
  );

DO $behavior$
DECLARE
  v_salon uuid := 'd8100000-0000-4000-8000-000000000001';
  v_booking_one uuid := 'd8100000-0000-4000-8000-000000000010';
  v_booking_two uuid := 'd8100000-0000-4000-8000-000000000011';
  v_owner_one text := 'owner-one@example.invalid';
  v_owner_two text := 'owner-two@example.invalid';
  v_owner_one_hash text := encode(extensions.digest(
    pg_catalog.convert_to('owner-one@example.invalid', 'UTF8'), 'sha256'
  ), 'hex');
  v_owner_two_hash text := encode(extensions.digest(
    pg_catalog.convert_to('owner-two@example.invalid', 'UTF8'), 'sha256'
  ), 'hex');
  v_wrong_hash text := repeat('f', 64);
  v_claim_one uuid;
  v_claim_two uuid;
  v_result jsonb;
  v_delivered_at timestamptz := transaction_timestamp() - interval '2 minutes';
BEGIN
  v_result := public.claim_owner_booking_notification(
    v_salon, v_booking_one, 'new', v_owner_one, 'owner-delivery-occurrence-1'
  );
  IF v_result->>'code' <> 'claimed' THEN
    RAISE EXCEPTION 'initial owner claim failed: %', v_result;
  END IF;
  v_claim_one := (v_result->>'claim_id')::uuid;

  -- The signed provider event may arrive before the send-completion transaction.
  v_result := public.record_resend_owner_delivery_event(
    v_claim_one, 'evt-owner-delivered-1', 'msg-owner-delivery-1', 'email.delivered',
    v_owner_one_hash, v_delivered_at, repeat('a', 64)
  );
  IF v_result->>'code' <> 'event_applied'
     OR NOT (v_result->>'applied')::boolean THEN
    RAISE EXCEPTION 'tagged webhook did not reconcile before completion: %', v_result;
  END IF;

  v_result := public.complete_owner_booking_notification(
    v_claim_one, 'sent', 'msg-owner-delivery-1', NULL
  );
  IF v_result->>'code' <> 'already_completed'
     OR NOT EXISTS (
       SELECT 1 FROM public.owner_booking_notification_claims c
       WHERE c.id = v_claim_one
         AND c.status = 'sent'
         AND c.delivery_status = 'delivered'
         AND c.provider_accepted_at IS NOT NULL
         AND c.delivered_at = v_delivered_at
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.resend_owner_delivery_events e
       WHERE e.provider_event_id = 'evt-owner-delivered-1'
         AND e.claim_id = v_claim_one
         AND e.applied_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'claim correlation trigger did not apply delivery truth: %', v_result;
  END IF;

  -- Exact provider replay is idempotent; changed material for the same event ID conflicts.
  v_result := public.record_resend_owner_delivery_event(
    v_claim_one, 'evt-owner-delivered-1', 'msg-owner-delivery-1', 'email.delivered',
    v_owner_one_hash, v_delivered_at, repeat('a', 64)
  );
  IF v_result->>'code' <> 'event_replay'
     OR (SELECT count(*) FROM public.resend_owner_delivery_events
         WHERE provider_event_id = 'evt-owner-delivered-1') <> 1 THEN
    RAISE EXCEPTION 'exact event replay was not idempotent: %', v_result;
  END IF;
  v_result := public.record_resend_owner_delivery_event(
    v_claim_one, 'evt-owner-delivered-1', 'msg-owner-delivery-1', 'email.delivered',
    v_owner_one_hash, v_delivered_at, repeat('b', 64)
  );
  IF v_result->>'code' <> 'event_conflict' THEN
    RAISE EXCEPTION 'changed event replay did not conflict: %', v_result;
  END IF;

  -- A delayed event that occurred earlier cannot downgrade a delivered message.
  v_result := public.record_resend_owner_delivery_event(
    v_claim_one, 'evt-owner-delayed-1', 'msg-owner-delivery-1', 'email.delivery_delayed',
    v_owner_one_hash, v_delivered_at - interval '1 minute', repeat('c', 64)
  );
  IF v_result->>'code' <> 'event_applied'
     OR (SELECT delivery_status FROM public.owner_booking_notification_claims
         WHERE id = v_claim_one) <> 'delivered' THEN
    RAISE EXCEPTION 'delayed event downgraded delivered truth: %', v_result;
  END IF;

  -- Complaint is terminal and creates a salon-scoped, hash-only suppression.
  v_result := public.record_resend_owner_delivery_event(
    v_claim_one, 'evt-owner-complained-1', 'msg-owner-delivery-1', 'email.complained',
    v_owner_one_hash, v_delivered_at + interval '1 minute', repeat('d', 64)
  );
  IF v_result->>'code' <> 'event_applied'
     OR (SELECT delivery_status FROM public.owner_booking_notification_claims
         WHERE id = v_claim_one) <> 'complained'
     OR NOT EXISTS (
       SELECT 1 FROM public.owner_email_delivery_suppressions s
       WHERE s.salon_id = v_salon
         AND s.recipient_fingerprint = v_owner_one_hash
         AND s.reason = 'complained'
     ) THEN
    RAISE EXCEPTION 'complaint truth/suppression was not applied: %', v_result;
  END IF;
  v_result := public.claim_owner_booking_notification(
    v_salon, v_booking_two, 'new', v_owner_one, 'owner-delivery-occurrence-2'
  );
  IF v_result->>'code' <> 'provider_suppressed'
     OR (v_result->>'claimed')::boolean
     OR EXISTS (
       SELECT 1 FROM public.owner_booking_notification_claims c
       WHERE c.booking_id = v_booking_two
         AND c.recipient_identity = v_owner_one
     ) THEN
    RAISE EXCEPTION 'future send bypassed provider suppression: %', v_result;
  END IF;

  -- A validly signed event for the wrong recipient never mutates the claim.
  v_result := public.claim_owner_booking_notification(
    v_salon, v_booking_two, 'new', v_owner_two, 'owner-delivery-occurrence-3'
  );
  IF v_result->>'code' <> 'claimed' THEN
    RAISE EXCEPTION 'recipient-mismatch setup claim failed: %', v_result;
  END IF;
  v_claim_two := (v_result->>'claim_id')::uuid;
  v_result := public.record_resend_owner_delivery_event(
    v_claim_two, 'evt-owner-message-conflict', 'msg-owner-delivery-1',
    'email.delivered', v_owner_two_hash,
    transaction_timestamp() - interval '45 seconds', repeat('9', 64)
  );
  IF v_result->>'code' <> 'event_rejected'
     OR EXISTS (
       SELECT 1 FROM public.owner_booking_notification_claims c
       WHERE c.id = v_claim_two AND c.provider_message_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'provider message was rebound across claims: %', v_result;
  END IF;
  PERFORM public.complete_owner_booking_notification(
    v_claim_two, 'sent', 'msg-owner-delivery-2', NULL
  );
  v_result := public.record_resend_owner_delivery_event(
    v_claim_two, 'evt-owner-wrong-recipient', 'msg-owner-delivery-2', 'email.bounced',
    v_wrong_hash, transaction_timestamp() - interval '30 seconds', repeat('e', 64)
  );
  IF v_result->>'code' <> 'event_rejected'
     OR (SELECT delivery_status FROM public.owner_booking_notification_claims
         WHERE id = v_claim_two) <> 'provider_accepted'
     OR EXISTS (
       SELECT 1 FROM public.owner_email_delivery_suppressions s
       WHERE s.salon_id = v_salon AND s.recipient_fingerprint = v_wrong_hash
     ) THEN
    RAISE EXCEPTION 'recipient mismatch mutated delivery truth: %', v_result;
  END IF;

  IF v_owner_two_hash = v_wrong_hash THEN
    RAISE EXCEPTION 'test fingerprints unexpectedly collide';
  END IF;
END;
$behavior$;

DO $boundary$
BEGIN
  IF has_table_privilege('anon', 'public.resend_owner_delivery_events', 'SELECT')
     OR has_table_privilege('anon', 'public.resend_owner_delivery_events', 'INSERT')
     OR has_table_privilege('authenticated', 'public.resend_owner_delivery_events', 'SELECT')
     OR has_table_privilege('service_role', 'public.resend_owner_delivery_events', 'SELECT')
     OR has_table_privilege('service_role', 'public.resend_owner_delivery_events', 'INSERT')
     OR has_table_privilege('anon', 'public.owner_email_delivery_suppressions', 'SELECT')
     OR has_table_privilege('authenticated', 'public.owner_email_delivery_suppressions', 'SELECT')
     OR has_table_privilege('service_role', 'public.owner_email_delivery_suppressions', 'SELECT') THEN
    RAISE EXCEPTION 'delivery truth tables became directly reachable';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.record_resend_owner_delivery_event(uuid,text,text,text,text,timestamptz,text)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.record_resend_owner_delivery_event(uuid,text,text,text,text,timestamptz,text)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.record_resend_owner_delivery_event(uuid,text,text,text,text,timestamptz,text)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.reconcile_resend_owner_delivery_events(text)'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'delivery truth RPC ACL mismatch';
  END IF;

  IF NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
          WHERE c.oid = 'public.resend_owner_delivery_events'::regclass)
     OR NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
             WHERE c.oid = 'public.owner_email_delivery_suppressions'::regclass) THEN
    RAISE EXCEPTION 'delivery truth RLS missing';
  END IF;
END;
$boundary$;

ROLLBACK;

SELECT 'PASS Resend owner delivery truth replay, race, suppression and ACLs' AS result;

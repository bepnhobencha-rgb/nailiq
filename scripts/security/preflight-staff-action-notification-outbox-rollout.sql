\set ON_ERROR_STOP on

DO $preflight$
DECLARE v_booking_rows bigint; v_booking_bytes bigint; v_active bigint; v_bad bigint;
BEGIN
  SELECT greatest(coalesce(c.reltuples,0)::bigint,0),pg_total_relation_size(c.oid)
  INTO v_booking_rows,v_booking_bytes FROM pg_class c WHERE c.oid='public.bookings'::regclass;
  SELECT count(*) INTO v_active FROM public.staff_action_notification_outbox WHERE status='active';
  SELECT count(*) INTO v_bad
  FROM public.staff_action_notification_deliveries d
  JOIN public.staff_action_notification_outbox o ON o.id=d.outbox_id
  LEFT JOIN public.staff_action_notification_envelopes e ON e.delivery_id=d.id
  WHERE d.salon_id<>o.salon_id OR d.booking_id<>o.booking_id
     OR (d.status IN ('pending','sending') AND (
       e.delivery_id IS NULL OR e.payload_fingerprint<>d.payload_fingerprint
       OR encode(extensions.digest(convert_to(e.dispatch_envelope,'UTF8'),'sha256'),'hex')
          <>d.payload_fingerprint));
  RAISE NOTICE 'bookings estimated_rows=%, total_bytes=%, active_staff_action_events=%',
    v_booking_rows,v_booking_bytes,v_active;
  IF v_bad<>0 THEN RAISE EXCEPTION 'unsafe staff-action rows found: %',v_bad; END IF;
  IF EXISTS (SELECT 1 FROM public.bookings WHERE
    staff_action_notification_request_id IS NOT NULL
    OR staff_action_notification_actor_user_id IS NOT NULL
    OR staff_action_notification_actor_role IS NOT NULL
    OR staff_action_notification_channels IS NOT NULL
    OR staff_action_notification_delay_seconds IS NOT NULL) THEN
    RAISE EXCEPTION 'ephemeral staff-action inputs persisted';
  END IF;
END;$preflight$;

SELECT count(*) AS legacy_scheduled_staff_notifications
FROM public.scheduled_notifications
WHERE event IN ('create','reschedule','cancel');

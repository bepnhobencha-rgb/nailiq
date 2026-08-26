-- Extend the existing staff-action outbox to cover provider-only staff changes.
-- The sick-call/offboarding mutation, every booking reassignment, access revoke,
-- staff deactivation, immutable outbox material and replay receipt now commit or
-- roll back together. Provider delivery remains exclusively worker-owned.

-- Replace the event check with a strict superset without leaving an unchecked
-- interval. The existing table may already contain live create/reschedule/cancel
-- rows, so validate the additive constraint before removing the old name.
ALTER TABLE public.staff_action_notification_outbox
  ADD CONSTRAINT staff_action_notification_outbox_event_type_check_v2
  CHECK (event_type IN ('create','reschedule','cancel','staff_change')) NOT VALID;
ALTER TABLE public.staff_action_notification_outbox
  VALIDATE CONSTRAINT staff_action_notification_outbox_event_type_check_v2;
ALTER TABLE public.staff_action_notification_outbox
  DROP CONSTRAINT staff_action_notification_outbox_event_type_check;
ALTER TABLE public.staff_action_notification_outbox
  RENAME CONSTRAINT staff_action_notification_outbox_event_type_check_v2
  TO staff_action_notification_outbox_event_type_check;

CREATE TABLE public.staff_offboarding_receipts (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL,
  request_id uuid NOT NULL,
  actor_user_id uuid,
  actor_role text NOT NULL CHECK (
    actor_role IN ('owner','admin','demo_cookie')
  ),
  requested_channels jsonb NOT NULL CHECK (
    jsonb_typeof(requested_channels)='object'
    AND requested_channels ? 'sms' AND requested_channels ? 'email'
    AND jsonb_typeof(requested_channels->'sms')='boolean'
    AND jsonb_typeof(requested_channels->'email')='boolean'
  ),
  revoke_access boolean NOT NULL,
  assignment_fingerprint text NOT NULL CHECK (
    assignment_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json)='object'),
  result_fingerprint text NOT NULL CHECK (
    result_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT staff_offboarding_receipts_request_once UNIQUE(salon_id,request_id),
  CONSTRAINT staff_offboarding_receipts_actor_check CHECK (
    (actor_user_id IS NOT NULL AND actor_role IN ('owner','admin'))
    OR (actor_user_id IS NULL AND actor_role='demo_cookie')
  )
);

CREATE INDEX staff_offboarding_receipts_salon_staff_created_idx
  ON public.staff_offboarding_receipts(salon_id,staff_id,created_at DESC,id);

ALTER TABLE public.staff_offboarding_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.staff_offboarding_receipts
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.staff_offboarding_receipts TO service_role;
CREATE POLICY "deny browser access to staff offboarding receipts"
  ON public.staff_offboarding_receipts AS RESTRICTIVE
  FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

COMMENT ON TABLE public.staff_offboarding_receipts IS
  'PII-free immutable replay receipts for atomic staff offboarding and booking reassignment.';

-- Derive a distinct, stable outbox request id for each booking from the single
-- offboarding request. This preserves the existing one-request-per-occurrence
-- outbox uniqueness contract while making a multi-booking replay exact.
CREATE FUNCTION public.staff_offboarding_notification_request_id(
  p_request_id uuid,p_booking_id uuid
) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path TO '' AS $derive$
  SELECT (
    substr(h,1,8)||'-'||substr(h,9,4)||'-5'||substr(h,14,3)||
    '-8'||substr(h,18,3)||'-'||substr(h,21,12)
  )::uuid
  FROM (
    SELECT encode(extensions.digest(
      convert_to(p_request_id::text||':staff-change:'||p_booking_id::text,'UTF8'),
      'sha256'
    ),'hex') AS h
  ) material
$derive$;

-- This trigger is intentionally named immediately before the existing
-- zz_capture_staff_action_notification_occurrence trigger. It consumes only a
-- pure staff-id change; create, time-change and cancellation occurrences remain
-- owned by the original trigger and contract.
CREATE FUNCTION public.capture_staff_change_notification_occurrence()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $capture_staff_change$
DECLARE
  v_request_id uuid:=NEW.staff_action_notification_request_id;
  v_actor_user_id uuid:=NEW.staff_action_notification_actor_user_id;
  v_actor_role text:=nullif(trim(coalesce(NEW.staff_action_notification_actor_role,'')),'');
  v_channels jsonb:=NEW.staff_action_notification_channels;
  v_delay integer:=NEW.staff_action_notification_delay_seconds;
  v_occurrence bigint;
  v_salon public.salons%ROWTYPE;
  v_service_name text;
  v_staff_name text;
  v_snapshot jsonb;
  v_result_snapshot jsonb;
  v_fingerprint text;
  v_outbox public.staff_action_notification_outbox%ROWTYPE;
  v_existing public.staff_action_notification_outbox%ROWTYPE;
  v_now timestamptz:=transaction_timestamp();
  v_setting text;
BEGIN
  IF TG_OP<>'UPDATE'
     OR NEW.staff_id IS NOT DISTINCT FROM OLD.staff_id
     OR (NEW.status='cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
     OR NEW.start_time_utc IS DISTINCT FROM OLD.start_time_utc THEN
    RETURN NEW;
  END IF;

  IF v_request_id IS NULL THEN
    v_setting:=nullif(current_setting('nailiq.staff_action_request_id',true),'');
    IF v_setting IS NOT NULL THEN v_request_id:=v_setting::uuid; END IF;
  END IF;
  IF v_actor_user_id IS NULL THEN
    v_setting:=nullif(current_setting('nailiq.staff_action_actor_user_id',true),'');
    IF v_setting IS NOT NULL THEN v_actor_user_id:=v_setting::uuid; END IF;
  END IF;
  v_actor_role:=coalesce(v_actor_role,
    nullif(current_setting('nailiq.staff_action_actor_role',true),''));
  IF v_channels IS NULL THEN
    v_setting:=nullif(current_setting('nailiq.staff_action_channels',true),'');
    IF v_setting IS NOT NULL THEN v_channels:=v_setting::jsonb; END IF;
  END IF;
  IF v_delay IS NULL THEN
    v_setting:=nullif(current_setting('nailiq.staff_action_delay_seconds',true),'');
    IF v_setting IS NOT NULL THEN v_delay:=v_setting::integer; END IF;
  END IF;

  IF v_request_id IS NULL AND v_channels IS NULL THEN RETURN NEW; END IF;
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RAISE EXCEPTION 'staff action notification inputs require service_role'
      USING ERRCODE='insufficient_privilege';
  END IF;
  IF v_request_id IS NULL OR v_actor_role IS NULL OR v_channels IS NULL
     OR v_delay NOT BETWEEN 0 AND 120
     OR jsonb_typeof(v_channels)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_channels))<>2
     OR NOT (v_channels ? 'sms' AND v_channels ? 'email')
     OR jsonb_typeof(v_channels->'sms')<>'boolean'
     OR jsonb_typeof(v_channels->'email')<>'boolean'
     OR NOT (coalesce((v_channels->>'sms')::boolean,false)
       OR coalesce((v_channels->>'email')::boolean,false)) THEN
    RAISE EXCEPTION 'invalid staff change notification inputs'
      USING ERRCODE='check_violation';
  END IF;

  -- Inputs and transaction-local fallbacks are one-shot and never persist on
  -- the booking row. The legacy zz trigger consequently observes no request.
  NEW.staff_action_notification_request_id:=NULL;
  NEW.staff_action_notification_actor_user_id:=NULL;
  NEW.staff_action_notification_actor_role:=NULL;
  NEW.staff_action_notification_channels:=NULL;
  NEW.staff_action_notification_delay_seconds:=NULL;
  PERFORM pg_catalog.set_config('nailiq.staff_action_request_id','',true);
  PERFORM pg_catalog.set_config('nailiq.staff_action_actor_user_id','',true);
  PERFORM pg_catalog.set_config('nailiq.staff_action_actor_role','',true);
  PERFORM pg_catalog.set_config('nailiq.staff_action_channels','',true);
  PERFORM pg_catalog.set_config('nailiq.staff_action_delay_seconds','',true);
  PERFORM pg_catalog.set_config('nailiq.staff_action_affected_booking_ids','',true);

  IF v_actor_user_id IS NULL THEN
    IF v_actor_role NOT IN ('system','demo_cookie') THEN
      RAISE EXCEPTION 'staff notification actor missing' USING ERRCODE='check_violation';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.salon_members m
    WHERE m.salon_id=NEW.salon_id AND m.user_id=v_actor_user_id AND m.role=v_actor_role
      AND m.role IN ('owner','admin','senior','receptionist','nail_tech')
  ) THEN
    RAISE EXCEPTION 'staff notification actor unauthorized'
      USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT coalesce(max(o.occurrence_version),0)+1 INTO v_occurrence
  FROM public.staff_action_notification_outbox o
  WHERE o.booking_id=NEW.id AND o.event_type='staff_change';

  v_result_snapshot:=jsonb_build_object(
    'salon_id',NEW.salon_id,'booking_id',NEW.id,'group_id',NEW.group_id,
    'event','staff_change','occurrence_version',v_occurrence,
    'booking_ids',jsonb_build_array(NEW.id),'affected_count',1,
    'previous_staff_id',OLD.staff_id,'staff_id',NEW.staff_id
  );

  SELECT s.* INTO STRICT v_salon FROM public.salons s
    WHERE s.id=NEW.salon_id FOR SHARE;
  SELECT sv.name INTO STRICT v_service_name FROM public.services sv
    WHERE sv.id=NEW.service_id AND sv.salon_id=NEW.salon_id;
  IF NEW.staff_id IS NOT NULL THEN
    SELECT st.name INTO v_staff_name FROM public.staff st
    WHERE st.id=NEW.staff_id AND st.salon_id=NEW.salon_id;
  END IF;
  IF NEW.staff_id IS NULL OR v_staff_name IS NULL THEN
    RAISE EXCEPTION 'staff change replacement missing' USING ERRCODE='check_violation';
  END IF;

  v_snapshot:=jsonb_build_object(
    'contract_version',1,'salon_id',NEW.salon_id,'booking_id',NEW.id,
    'request_id',v_request_id,'event','staff_change','occurrence_version',v_occurrence,
    'actor_user_id',v_actor_user_id,'actor_role',v_actor_role,
    'client_name',coalesce(NEW.client_name,''),
    'client_phone',nullif(regexp_replace(coalesce(NEW.client_phone,''),'\D','','g'),''),
    'client_email',nullif(lower(trim(coalesce(NEW.client_email,''))),''),
    'locale',CASE lower(trim(split_part(coalesce(nullif(NEW.client_locale,''),
      nullif(v_salon.default_notification_locale,''),'en'),'-',1))) WHEN 'vi' THEN 'vi' ELSE 'en' END,
    'start_time_utc',NEW.start_time_utc,'service_id',NEW.service_id,
    'service_name',v_service_name,'staff_id',NEW.staff_id,'staff_name',v_staff_name,
    'previous_staff_id',OLD.staff_id,
    'salon_name',v_salon.name,'salon_slug',v_salon.slug,'salon_timezone',v_salon.timezone,
    'salon_phone',coalesce(nullif(v_salon.salon_phone,''),v_salon.phone),
    'salon_logo_url',v_salon.logo_url,
    'salon_is_test',(v_salon.slug ~* '^e2e[-_]' OR v_salon.name ~* '^e2e\y'),
    'sms_outbound_enabled',v_salon.sms_outbound_enabled,
    'email_outbound_enabled',v_salon.email_outbound_enabled,
    'requested_channels',v_channels
  )||jsonb_build_object('action_result',v_result_snapshot);
  v_fingerprint:=encode(extensions.digest(
    convert_to(v_snapshot::text,'UTF8'),'sha256'),'hex');

  INSERT INTO public.staff_action_notification_outbox(
    salon_id,booking_id,request_id,event_type,occurrence_version,
    actor_user_id,actor_role,requested_channels,result_snapshot,material_snapshot,
    material_fingerprint,notification_delay_seconds,send_after,expires_at
  ) VALUES (
    NEW.salon_id,NEW.id,v_request_id,'staff_change',v_occurrence,
    v_actor_user_id,v_actor_role,v_channels,v_result_snapshot,v_snapshot,
    v_fingerprint,v_delay,v_now+make_interval(secs=>v_delay),
    v_now+make_interval(secs=>v_delay)+interval '30 minutes'
  ) ON CONFLICT (salon_id,request_id) DO NOTHING
  RETURNING * INTO v_outbox;
  IF NOT FOUND THEN
    SELECT o.* INTO STRICT v_existing
    FROM public.staff_action_notification_outbox o
    WHERE o.salon_id=NEW.salon_id AND o.request_id=v_request_id FOR UPDATE;
    IF v_existing.booking_id<>NEW.id OR v_existing.event_type<>'staff_change'
       OR v_existing.occurrence_version<>v_occurrence
       OR v_existing.material_fingerprint<>v_fingerprint THEN
      RAISE EXCEPTION 'staff notification idempotency conflict'
        USING ERRCODE='unique_violation';
    END IF;
    v_outbox:=v_existing;
  END IF;
  IF coalesce((v_channels->>'sms')::boolean,false) THEN
    INSERT INTO public.staff_action_notification_deliveries(
      outbox_id,salon_id,booking_id,channel,provider_name
    ) VALUES(v_outbox.id,NEW.salon_id,NEW.id,'sms','twilio')
    ON CONFLICT DO NOTHING;
  END IF;
  IF coalesce((v_channels->>'email')::boolean,false) THEN
    INSERT INTO public.staff_action_notification_deliveries(
      outbox_id,salon_id,booking_id,channel,provider_name
    ) VALUES(v_outbox.id,NEW.salon_id,NEW.id,'email','resend')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$capture_staff_change$;

CREATE TRIGGER zy_capture_staff_change_notification_occurrence
BEFORE UPDATE ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.capture_staff_change_notification_occurrence();

CREATE FUNCTION public.offboard_staff_with_durable_notifications(
  p_salon_id uuid,p_staff_id uuid,p_request_id uuid,p_actor_user_id uuid,
  p_actor_role text,p_assignments jsonb,p_notify_email boolean,p_notify_sms boolean,
  p_revoke_access boolean,p_notification_delay_seconds integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $offboard$
DECLARE
  v_channels jsonb;
  v_assignments jsonb;
  v_request_material jsonb;
  v_assignment_fingerprint text;
  v_result_fingerprint text;
  v_receipt public.staff_offboarding_receipts%ROWTYPE;
  v_target public.staff%ROWTYPE;
  v_assignment record;
  v_notification_request_id uuid;
  v_reassignable_count integer;
  v_outbox_count integer:=0;
  v_delivery_count integer:=0;
  v_actor_role text;
  v_result jsonb;
  v_access_revoked boolean:=false;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_staff_id IS NULL OR p_request_id IS NULL
     OR p_actor_role IS NULL OR p_notify_email IS NULL OR p_notify_sms IS NULL
     OR p_revoke_access IS NULL OR p_notification_delay_seconds NOT BETWEEN 0 AND 120
     OR jsonb_typeof(p_assignments)<>'array'
     OR jsonb_array_length(p_assignments)>100 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_assignments) item
    WHERE jsonb_typeof(item)<>'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key)
        IS DISTINCT FROM ARRAY['booking_id','staff_id']::text[]
      OR coalesce(item->>'booking_id','') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR coalesce(item->>'staff_id','') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'booking_id',(item->>'booking_id')::uuid,
      'staff_id',(item->>'staff_id')::uuid
    ) ORDER BY (item->>'booking_id')::uuid),'[]'::jsonb)
  INTO v_assignments
  FROM jsonb_array_elements(p_assignments) item;
  IF (SELECT count(*) FROM jsonb_array_elements(v_assignments))<>
     (SELECT count(DISTINCT item->>'booking_id') FROM jsonb_array_elements(v_assignments) item)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_assignments) item
       WHERE (item->>'staff_id')::uuid=p_staff_id) THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;

  v_channels:=jsonb_build_object('sms',p_notify_sms,'email',p_notify_email);
  v_request_material:=jsonb_build_object(
    'salon_id',p_salon_id,'staff_id',p_staff_id,'request_id',p_request_id,
    'actor_user_id',p_actor_user_id,'actor_role',p_actor_role,
    'assignments',v_assignments,'requested_channels',v_channels,
    'revoke_access',p_revoke_access,
    'notification_delay_seconds',p_notification_delay_seconds
  );
  v_assignment_fingerprint:=encode(extensions.digest(
    convert_to(v_request_material::text,'UTF8'),'sha256'),'hex');

  -- A salon-wide transaction lock prevents two different staff offboardings
  -- from concurrently violating the minimum-active-staff invariant.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'staff-offboarding:'||p_salon_id::text,0));
  SELECT * INTO v_receipt FROM public.staff_offboarding_receipts r
  WHERE r.salon_id=p_salon_id AND r.request_id=p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_receipt.staff_id IS DISTINCT FROM p_staff_id
       OR v_receipt.actor_user_id IS DISTINCT FROM p_actor_user_id
       OR v_receipt.actor_role IS DISTINCT FROM p_actor_role
       OR v_receipt.requested_channels IS DISTINCT FROM v_channels
       OR v_receipt.revoke_access IS DISTINCT FROM p_revoke_access
       OR v_receipt.assignment_fingerprint IS DISTINCT FROM v_assignment_fingerprint THEN
      RETURN jsonb_build_object('success',false,'code','idempotency_mismatch');
    END IF;
    RETURN v_receipt.result_json||jsonb_build_object('idempotent',true);
  END IF;

  IF p_actor_user_id IS NULL THEN
    IF p_actor_role<>'demo_cookie' OR p_notify_email OR p_notify_sms THEN
      RETURN jsonb_build_object('success',false,'code','actor_unauthorized');
    END IF;
    v_actor_role:='demo_cookie';
  ELSE
    SELECT m.role INTO v_actor_role FROM public.salon_members m
    WHERE m.salon_id=p_salon_id AND m.user_id=p_actor_user_id
      AND m.role IN ('owner','admin') LIMIT 1;
    IF v_actor_role IS NULL OR v_actor_role IS DISTINCT FROM p_actor_role THEN
      RETURN jsonb_build_object('success',false,'code','actor_unauthorized');
    END IF;
  END IF;

  PERFORM 1 FROM public.staff s
  WHERE s.salon_id=p_salon_id AND s.deleted_at IS NULL
  ORDER BY s.id FOR UPDATE;
  SELECT * INTO v_target FROM public.staff s
  WHERE s.id=p_staff_id AND s.salon_id=p_salon_id AND s.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','not_found'); END IF;
  IF v_target.status='inactive' THEN
    RETURN jsonb_build_object('success',false,'code','already_inactive');
  END IF;
  IF v_target.status<>'active' THEN
    RETURN jsonb_build_object('success',false,'code','stale_staff');
  END IF;
  IF v_target.user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.salon_members m
    WHERE m.salon_id=p_salon_id AND m.user_id=v_target.user_id AND m.role='owner'
  ) THEN
    RETURN jsonb_build_object('success',false,'code','owner_access_protected');
  END IF;
  IF (SELECT count(*) FROM public.staff s
      WHERE s.salon_id=p_salon_id AND s.id<>p_staff_id
        AND s.status='active' AND s.deleted_at IS NULL)<1 THEN
    RETURN jsonb_build_object('success',false,'code','minimum_active_staff');
  END IF;

  PERFORM 1 FROM public.bookings b
  WHERE b.salon_id=p_salon_id AND b.staff_id=p_staff_id AND b.deleted_at IS NULL
    AND b.status IN ('pending','confirmed','in_progress','waiting')
  ORDER BY b.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.bookings b
    WHERE b.salon_id=p_salon_id AND b.staff_id=p_staff_id AND b.deleted_at IS NULL
      AND b.status IN ('in_progress','waiting')) THEN
    RETURN jsonb_build_object('success',false,'code','operational_booking_blocked');
  END IF;
  SELECT count(*) INTO v_reassignable_count FROM public.bookings b
  WHERE b.salon_id=p_salon_id AND b.staff_id=p_staff_id AND b.deleted_at IS NULL
    AND b.status IN ('pending','confirmed');
  IF v_reassignable_count<>jsonb_array_length(v_assignments)
     OR EXISTS (
       SELECT 1 FROM public.bookings b
       WHERE b.salon_id=p_salon_id AND b.staff_id=p_staff_id AND b.deleted_at IS NULL
         AND b.status IN ('pending','confirmed')
         AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_assignments)
           AS a(booking_id uuid,staff_id uuid) WHERE a.booking_id=b.id)
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_to_recordset(v_assignments) AS a(booking_id uuid,staff_id uuid)
       LEFT JOIN public.bookings b ON b.id=a.booking_id AND b.salon_id=p_salon_id
         AND b.staff_id=p_staff_id AND b.deleted_at IS NULL
         AND b.status IN ('pending','confirmed')
       WHERE b.id IS NULL
     ) THEN
    RETURN jsonb_build_object('success',false,'code','assign_every_booking');
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_assignments) AS a(booking_id uuid,staff_id uuid)
    LEFT JOIN public.staff s ON s.id=a.staff_id AND s.salon_id=p_salon_id
      AND s.status='active' AND s.deleted_at IS NULL
    WHERE s.id IS NULL
  ) THEN
    RETURN jsonb_build_object('success',false,'code','candidate_unavailable');
  END IF;
  IF EXISTS (
      SELECT 1 FROM public.staff_services configured
      JOIN public.staff configured_staff ON configured_staff.id=configured.staff_id
      WHERE configured_staff.salon_id=p_salon_id
    ) AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(v_assignments) AS a(booking_id uuid,staff_id uuid)
      JOIN public.bookings b ON b.id=a.booking_id
      WHERE NOT EXISTS (SELECT 1 FROM public.staff_services ss
              WHERE ss.staff_id=a.staff_id AND ss.service_id=b.service_id)
         OR (b.addon_service_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM public.staff_services ss
              WHERE ss.staff_id=a.staff_id AND ss.service_id=b.addon_service_id))
    ) THEN
    RETURN jsonb_build_object('success',false,'code','candidate_unavailable');
  END IF;

  FOR v_assignment IN
    SELECT * FROM jsonb_to_recordset(v_assignments)
      AS a(booking_id uuid,staff_id uuid) ORDER BY booking_id
  LOOP
    IF p_notify_email OR p_notify_sms THEN
      v_notification_request_id:=public.staff_offboarding_notification_request_id(
        p_request_id,v_assignment.booking_id);
      UPDATE public.bookings SET
        staff_id=v_assignment.staff_id,
        staff_action_notification_request_id=v_notification_request_id,
        staff_action_notification_actor_user_id=p_actor_user_id,
        staff_action_notification_actor_role=v_actor_role,
        staff_action_notification_channels=v_channels,
        staff_action_notification_delay_seconds=p_notification_delay_seconds
      WHERE id=v_assignment.booking_id AND salon_id=p_salon_id
        AND staff_id=p_staff_id AND status IN ('pending','confirmed')
        AND deleted_at IS NULL;
    ELSE
      UPDATE public.bookings SET staff_id=v_assignment.staff_id
      WHERE id=v_assignment.booking_id AND salon_id=p_salon_id
        AND staff_id=p_staff_id AND status IN ('pending','confirmed')
        AND deleted_at IS NULL;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'atomic staff offboarding booking changed'
        USING ERRCODE='NI002';
    END IF;
  END LOOP;

  IF p_revoke_access AND v_target.user_id IS NOT NULL THEN
    DELETE FROM public.salon_members m
    WHERE m.salon_id=p_salon_id AND m.user_id=v_target.user_id AND m.role<>'owner';
    UPDATE public.staff SET user_id=NULL
    WHERE id=p_staff_id AND salon_id=p_salon_id AND user_id=v_target.user_id;
    v_access_revoked:=true;
  END IF;
  UPDATE public.staff SET status='inactive'
  WHERE id=p_staff_id AND salon_id=p_salon_id AND status='active' AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'atomic staff offboarding deactivation failed'
      USING ERRCODE='NI002';
  END IF;

  IF p_notify_email OR p_notify_sms THEN
    SELECT count(DISTINCT o.id),count(d.id)
    INTO v_outbox_count,v_delivery_count
    FROM jsonb_to_recordset(v_assignments) AS a(booking_id uuid,staff_id uuid)
    LEFT JOIN public.staff_action_notification_outbox o
      ON o.salon_id=p_salon_id AND o.booking_id=a.booking_id
      AND o.request_id=public.staff_offboarding_notification_request_id(
        p_request_id,a.booking_id) AND o.event_type='staff_change'
    LEFT JOIN public.staff_action_notification_deliveries d ON d.outbox_id=o.id;
    IF v_outbox_count<>v_reassignable_count
       OR v_delivery_count<>v_reassignable_count*
         ((p_notify_email::integer)+(p_notify_sms::integer)) THEN
      RAISE EXCEPTION 'atomic staff change notification capture failed'
        USING ERRCODE='NI002';
    END IF;
  END IF;

  v_result:=jsonb_build_object(
    'success',true,'code','staff_offboarded','idempotent',false,
    'salon_id',p_salon_id,'staff_id',p_staff_id,'request_id',p_request_id,
    'reassigned_count',v_reassignable_count,'assignments',v_assignments,
    'notification_events_queued',v_outbox_count,
    'notification_deliveries_queued',v_delivery_count,
    'requested_channels',v_channels,'access_revoked',v_access_revoked
  );
  v_result_fingerprint:=encode(extensions.digest(
    convert_to(v_result::text,'UTF8'),'sha256'),'hex');
  INSERT INTO public.staff_offboarding_receipts(
    salon_id,staff_id,request_id,actor_user_id,actor_role,requested_channels,
    revoke_access,assignment_fingerprint,result_json,result_fingerprint
  ) VALUES(
    p_salon_id,p_staff_id,p_request_id,p_actor_user_id,v_actor_role,v_channels,
    p_revoke_access,v_assignment_fingerprint,v_result,v_result_fingerprint
  );
  RETURN v_result;
EXCEPTION
  WHEN exclusion_violation THEN
    RETURN jsonb_build_object('success',false,'code','candidate_unavailable');
END;
$offboard$;

REVOKE ALL ON FUNCTION public.staff_offboarding_notification_request_id(uuid,uuid),
  public.capture_staff_change_notification_occurrence()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.offboard_staff_with_durable_notifications(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.offboard_staff_with_durable_notifications(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
) TO service_role;

COMMENT ON FUNCTION public.offboard_staff_with_durable_notifications(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
) IS 'Service-role-only atomic staff offboarding, exact replay and durable staff-change notification capture; never calls a provider.';

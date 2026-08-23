-- Forward-only hardening for the durable staff-offboarding contract.
--
-- The first durable version only considered bookings.staff_id. Ordered
-- multi-service bookings keep authoritative staff capacity in
-- booking_service_segments, so this revision coordinates both scheduling
-- models, keeps the audit receipt in the same transaction, and rejects
-- notification channels that the salon has disabled. No provider is invoked.

ALTER TABLE public.staff_offboarding_receipts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.staff_offboarding_receipts IS
  'PII-free immutable replay receipts for atomic staff offboarding. No automatic retention or deletion is configured; removal requires an explicit operator-reviewed retention migration.';

ALTER TABLE public.booking_events
  ADD COLUMN staff_offboarding_request_id uuid;

ALTER TABLE public.booking_events
  ADD CONSTRAINT booking_events_staff_offboarding_request_check
  CHECK (
    staff_offboarding_request_id IS NULL
    OR (
      booking_id IS NOT NULL
      AND event_type = 'booking_edited'
      AND coalesce(payload->>'reason','') = 'staff_offboarding'
    )
  ) NOT VALID;

ALTER TABLE public.booking_events
  VALIDATE CONSTRAINT booking_events_staff_offboarding_request_check;

CREATE UNIQUE INDEX booking_events_staff_offboarding_request_booking_uidx
  ON public.booking_events(salon_id,staff_offboarding_request_id,booking_id)
  WHERE staff_offboarding_request_id IS NOT NULL;

COMMENT ON COLUMN public.booking_events.staff_offboarding_request_id IS
  'Durable staff-offboarding request identity. One canonical attributed audit event per affected booking.';

-- Every live scheduling write takes a key-share lock on its assigned active
-- staff row. Offboarding takes an update lock on the target first. A writer
-- that began first therefore becomes visible before the affected-booking scan;
-- a writer that began later waits and then rejects the inactive assignment.
CREATE OR REPLACE FUNCTION public.enforce_active_staff_for_live_booking()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $active_staff$
DECLARE
  v_staff_salon_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'bookings' THEN
    IF NEW.schedule_model <> 'single'
       OR NEW.status IN ('cancelled','no_show','completed')
       OR NEW.staff_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.reservation_status IN ('cancelled','no_show','completed') THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT st.salon_id INTO v_staff_salon_id
  FROM public.staff st
  WHERE st.id = NEW.staff_id
    AND st.status = 'active'
    AND st.deleted_at IS NULL
  FOR KEY SHARE;

  IF NOT FOUND OR v_staff_salon_id IS DISTINCT FROM NEW.salon_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'live booking requires active same-salon staff';
  END IF;
  RETURN NEW;
END;
$active_staff$;

REVOKE ALL ON FUNCTION public.enforce_active_staff_for_live_booking()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER enforce_active_staff_for_live_single_booking
  BEFORE INSERT OR UPDATE OF salon_id,staff_id,status,schedule_model
  ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_active_staff_for_live_booking();

CREATE TRIGGER enforce_active_staff_for_live_sequence_segment
  BEFORE INSERT OR UPDATE OF salon_id,staff_id,reservation_status
  ON public.booking_service_segments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_active_staff_for_live_booking();

-- The booking-row trigger remains the single durable notification capture
-- point. For a sequence where only a later segment changes, the RPC supplies
-- transaction-local, validated override material and performs an otherwise
-- harmless parent update so exactly one occurrence is captured per booking.
CREATE OR REPLACE FUNCTION public.capture_staff_change_notification_occurrence()
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
  v_service_id uuid:=NEW.service_id;
  v_service_name text;
  v_staff_id uuid:=NEW.staff_id;
  v_staff_name text;
  v_previous_staff_id uuid:=OLD.staff_id;
  v_affected_segment_ids jsonb:='[]'::jsonb;
  v_snapshot jsonb;
  v_result_snapshot jsonb;
  v_fingerprint text;
  v_outbox public.staff_action_notification_outbox%ROWTYPE;
  v_existing public.staff_action_notification_outbox%ROWTYPE;
  v_now timestamptz:=transaction_timestamp();
  v_setting text;
  v_force_booking_id uuid;
  v_forced boolean:=false;
BEGIN
  v_setting:=nullif(current_setting('nailiq.staff_change_force_booking_id',true),'');
  IF v_setting IS NOT NULL THEN
    v_force_booking_id:=v_setting::uuid;
    v_forced:=v_force_booking_id=NEW.id;
  END IF;

  IF TG_OP<>'UPDATE'
     OR (NEW.staff_id IS NOT DISTINCT FROM OLD.staff_id AND NOT v_forced)
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

  IF v_forced THEN
    v_setting:=nullif(current_setting('nailiq.staff_change_previous_staff_id',true),'');
    IF v_setting IS NOT NULL THEN v_previous_staff_id:=v_setting::uuid; END IF;
    v_setting:=nullif(current_setting('nailiq.staff_change_replacement_staff_id',true),'');
    IF v_setting IS NOT NULL THEN v_staff_id:=v_setting::uuid; END IF;
    v_setting:=nullif(current_setting('nailiq.staff_change_affected_segment_ids',true),'');
    IF v_setting IS NOT NULL THEN v_affected_segment_ids:=v_setting::jsonb; END IF;
    IF pg_catalog.jsonb_typeof(v_affected_segment_ids)<>'array'
       OR pg_catalog.jsonb_array_length(v_affected_segment_ids)<1
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements_text(v_affected_segment_ids) item
         LEFT JOIN public.booking_service_segments seg
           ON seg.id=item::uuid AND seg.booking_id=NEW.id
              AND seg.staff_id=v_staff_id
         WHERE seg.id IS NULL
       ) THEN
      RAISE EXCEPTION 'invalid forced sequence staff-change material'
        USING ERRCODE='check_violation';
    END IF;
    SELECT (pg_catalog.array_agg(seg.service_id ORDER BY seg.position))[1],
      pg_catalog.string_agg(DISTINCT seg.service_name,' + ' ORDER BY seg.service_name)
    INTO v_service_id,v_service_name
    FROM public.booking_service_segments seg
    WHERE seg.booking_id=NEW.id
      AND seg.id IN (
        SELECT value::uuid
        FROM pg_catalog.jsonb_array_elements_text(v_affected_segment_ids)
      )
    GROUP BY seg.booking_id;
  END IF;

  IF v_request_id IS NULL AND v_channels IS NULL THEN RETURN NEW; END IF;
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RAISE EXCEPTION 'staff action notification inputs require service_role'
      USING ERRCODE='insufficient_privilege';
  END IF;
  IF v_request_id IS NULL OR v_actor_role IS NULL OR v_channels IS NULL
     OR v_delay NOT BETWEEN 0 AND 120
     OR pg_catalog.jsonb_typeof(v_channels)<>'object'
     OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(v_channels))<>2
     OR NOT (v_channels ? 'sms' AND v_channels ? 'email')
     OR pg_catalog.jsonb_typeof(v_channels->'sms')<>'boolean'
     OR pg_catalog.jsonb_typeof(v_channels->'email')<>'boolean'
     OR NOT (coalesce((v_channels->>'sms')::boolean,false)
       OR coalesce((v_channels->>'email')::boolean,false)) THEN
    RAISE EXCEPTION 'invalid staff change notification inputs'
      USING ERRCODE='check_violation';
  END IF;

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
  PERFORM pg_catalog.set_config('nailiq.staff_change_force_booking_id','',true);
  PERFORM pg_catalog.set_config('nailiq.staff_change_previous_staff_id','',true);
  PERFORM pg_catalog.set_config('nailiq.staff_change_replacement_staff_id','',true);
  PERFORM pg_catalog.set_config('nailiq.staff_change_affected_segment_ids','',true);

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

  v_result_snapshot:=pg_catalog.jsonb_build_object(
    'salon_id',NEW.salon_id,'booking_id',NEW.id,'group_id',NEW.group_id,
    'event','staff_change','occurrence_version',v_occurrence,
    'booking_ids',pg_catalog.jsonb_build_array(NEW.id),'affected_count',1,
    'previous_staff_id',v_previous_staff_id,'staff_id',v_staff_id,
    'affected_segment_ids',v_affected_segment_ids
  );

  SELECT s.* INTO STRICT v_salon FROM public.salons s
    WHERE s.id=NEW.salon_id FOR SHARE;
  IF v_service_name IS NULL THEN
    SELECT sv.name INTO STRICT v_service_name FROM public.services sv
    WHERE sv.id=v_service_id AND sv.salon_id=NEW.salon_id;
  END IF;
  IF v_staff_id IS NOT NULL THEN
    SELECT st.name INTO v_staff_name FROM public.staff st
    WHERE st.id=v_staff_id AND st.salon_id=NEW.salon_id
      AND st.status='active' AND st.deleted_at IS NULL;
  END IF;
  IF v_staff_id IS NULL OR v_staff_name IS NULL THEN
    RAISE EXCEPTION 'staff change replacement missing' USING ERRCODE='check_violation';
  END IF;

  v_snapshot:=pg_catalog.jsonb_build_object(
    'contract_version',1,'salon_id',NEW.salon_id,'booking_id',NEW.id,
    'request_id',v_request_id,'event','staff_change','occurrence_version',v_occurrence,
    'actor_user_id',v_actor_user_id,'actor_role',v_actor_role,
    'client_name',coalesce(NEW.client_name,''),
    'client_phone',nullif(pg_catalog.regexp_replace(coalesce(NEW.client_phone,''),'\D','','g'),''),
    'client_email',nullif(pg_catalog.lower(pg_catalog.trim(coalesce(NEW.client_email,''))),''),
    'locale',CASE pg_catalog.lower(pg_catalog.trim(pg_catalog.split_part(coalesce(nullif(NEW.client_locale,''),
      nullif(v_salon.default_notification_locale,''),'en'),'-',1))) WHEN 'vi' THEN 'vi' ELSE 'en' END,
    'start_time_utc',NEW.start_time_utc,'service_id',v_service_id,
    'service_name',v_service_name,'staff_id',v_staff_id,'staff_name',v_staff_name,
    'previous_staff_id',v_previous_staff_id,
    'affected_segment_ids',v_affected_segment_ids,
    'salon_name',v_salon.name,'salon_slug',v_salon.slug,'salon_timezone',v_salon.timezone,
    'salon_phone',coalesce(nullif(v_salon.salon_phone,''),v_salon.phone),
    'salon_logo_url',v_salon.logo_url,
    'salon_is_test',(v_salon.slug ~* '^e2e[-_]' OR v_salon.name ~* '^e2e\y'),
    'sms_outbound_enabled',v_salon.sms_outbound_enabled,
    'email_outbound_enabled',v_salon.email_outbound_enabled,
    'requested_channels',v_channels
  )||pg_catalog.jsonb_build_object('action_result',v_result_snapshot);
  v_fingerprint:=pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_snapshot::text,'UTF8'),'sha256'),'hex');

  INSERT INTO public.staff_action_notification_outbox(
    salon_id,booking_id,request_id,event_type,occurrence_version,
    actor_user_id,actor_role,requested_channels,result_snapshot,material_snapshot,
    material_fingerprint,notification_delay_seconds,send_after,expires_at
  ) VALUES (
    NEW.salon_id,NEW.id,v_request_id,'staff_change',v_occurrence,
    v_actor_user_id,v_actor_role,v_channels,v_result_snapshot,v_snapshot,
    v_fingerprint,v_delay,v_now+pg_catalog.make_interval(secs=>v_delay),
    v_now+pg_catalog.make_interval(secs=>v_delay)+interval '30 minutes'
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

-- Insert missing canonical audits and prove every existing row matches the
-- immutable receipt material. This is also called on replay/recovery so a
-- separately damaged audit row can be detected and a missing row repaired.
CREATE OR REPLACE FUNCTION public.ensure_staff_offboarding_booking_events(
  p_salon_id uuid,p_staff_id uuid,p_request_id uuid,p_actor_user_id uuid,
  p_actor_role text,p_result jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $audit$
DECLARE
  v_expected integer;
  v_valid integer;
  v_audit_role text:=CASE WHEN p_actor_role='admin' THEN 'manager' ELSE p_actor_role END;
BEGIN
  IF p_salon_id IS NULL OR p_staff_id IS NULL OR p_request_id IS NULL
     OR p_actor_role IS NULL OR pg_catalog.jsonb_typeof(p_result)<>'object'
     OR pg_catalog.jsonb_typeof(p_result->'assignments')<>'array' THEN
    RAISE EXCEPTION 'invalid staff offboarding audit material'
      USING ERRCODE='check_violation';
  END IF;
  v_expected:=pg_catalog.jsonb_array_length(p_result->'assignments');

  INSERT INTO public.booking_events(
    booking_id,salon_id,actor_user_id,actor_role,event_type,payload,
    staff_offboarding_request_id
  )
  SELECT
    (item->>'booking_id')::uuid,p_salon_id,p_actor_user_id,v_audit_role,
    'booking_edited',
    pg_catalog.jsonb_build_object(
      'reason','staff_offboarding',
      'previous_staff_id',p_staff_id,
      'new_staff_id',(item->>'staff_id')::uuid,
      'schedule_model',coalesce(item->>'schedule_model',b.schedule_model),
      'affected_segment_ids',coalesce(item->'affected_segment_ids','[]'::jsonb)
    ),
    p_request_id
  FROM pg_catalog.jsonb_array_elements(p_result->'assignments') item
  JOIN public.bookings b
    ON b.id=(item->>'booking_id')::uuid AND b.salon_id=p_salon_id
  ON CONFLICT (salon_id,staff_offboarding_request_id,booking_id)
    WHERE staff_offboarding_request_id IS NOT NULL DO NOTHING;

  SELECT count(*) INTO v_valid
  FROM pg_catalog.jsonb_array_elements(p_result->'assignments') item
  JOIN public.bookings b
    ON b.id=(item->>'booking_id')::uuid AND b.salon_id=p_salon_id
  JOIN public.booking_events e
    ON e.salon_id=p_salon_id
   AND e.booking_id=b.id
   AND e.staff_offboarding_request_id=p_request_id
   AND e.actor_user_id IS NOT DISTINCT FROM p_actor_user_id
   AND e.actor_role=v_audit_role
   AND e.event_type='booking_edited'
   AND e.payload=pg_catalog.jsonb_build_object(
      'reason','staff_offboarding',
      'previous_staff_id',p_staff_id,
      'new_staff_id',(item->>'staff_id')::uuid,
      'schedule_model',coalesce(item->>'schedule_model',b.schedule_model),
      'affected_segment_ids',coalesce(item->'affected_segment_ids','[]'::jsonb)
    );
  IF v_valid<>v_expected THEN
    RAISE EXCEPTION 'staff offboarding audit receipt mismatch'
      USING ERRCODE='NI002';
  END IF;
  RETURN v_valid;
END;
$audit$;

REVOKE ALL ON FUNCTION public.ensure_staff_offboarding_booking_events(
  uuid,uuid,uuid,uuid,text,jsonb
) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.offboard_staff_with_durable_notifications(
  p_salon_id uuid,p_staff_id uuid,p_request_id uuid,p_actor_user_id uuid,
  p_actor_role text,p_assignments jsonb,p_notify_email boolean,p_notify_sms boolean,
  p_revoke_access boolean,p_notification_delay_seconds integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $offboard$
DECLARE
  v_channels jsonb;
  v_assignments jsonb;
  v_enriched_assignments jsonb:='[]'::jsonb;
  v_request_material jsonb;
  v_assignment_fingerprint text;
  v_result_fingerprint text;
  v_receipt public.staff_offboarding_receipts%ROWTYPE;
  v_salon public.salons%ROWTYPE;
  v_target public.staff%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_assignment record;
  v_notification_request_id uuid;
  v_affected_booking_ids uuid[]:='{}'::uuid[];
  v_affected_segment_ids jsonb;
  v_affected_line_ids jsonb;
  v_new_segments jsonb;
  v_new_timing_segments jsonb;
  v_new_intent_lines jsonb;
  v_new_snapshot jsonb;
  v_fingerprint_material jsonb;
  v_new_pricing_fingerprint text;
  v_reassignable_count integer;
  v_submitted_count integer;
  v_outbox_count integer:=0;
  v_delivery_count integer:=0;
  v_audit_count integer:=0;
  v_actor_role text;
  v_replacement_name text;
  v_result jsonb;
  v_access_revoked boolean:=false;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_staff_id IS NULL OR p_request_id IS NULL
     OR p_actor_role IS NULL OR p_notify_email IS NULL OR p_notify_sms IS NULL
     OR p_revoke_access IS NULL OR p_notification_delay_seconds NOT BETWEEN 0 AND 120
     OR p_assignments IS NULL OR pg_catalog.jsonb_typeof(p_assignments)<>'array' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  v_submitted_count:=pg_catalog.jsonb_array_length(p_assignments);
  IF v_submitted_count>100 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'code','too_many_bookings','limit',100,
      'submitted_count',v_submitted_count
    );
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_assignments) item
    WHERE pg_catalog.jsonb_typeof(item)<>'object'
      OR (SELECT pg_catalog.array_agg(key ORDER BY key)
          FROM pg_catalog.jsonb_object_keys(item) key)
        IS DISTINCT FROM ARRAY['booking_id','staff_id']::text[]
      OR coalesce(item->>'booking_id','') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR coalesce(item->>'staff_id','') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_input');
  END IF;

  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'booking_id',(item->>'booking_id')::uuid,
      'staff_id',(item->>'staff_id')::uuid
    ) ORDER BY (item->>'booking_id')::uuid),'[]'::jsonb)
  INTO v_assignments
  FROM pg_catalog.jsonb_array_elements(p_assignments) item;
  IF (SELECT count(*) FROM pg_catalog.jsonb_array_elements(v_assignments))<>
     (SELECT count(DISTINCT item->>'booking_id')
      FROM pg_catalog.jsonb_array_elements(v_assignments) item)
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_assignments) item
       WHERE (item->>'staff_id')::uuid=p_staff_id) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_input');
  END IF;

  v_channels:=pg_catalog.jsonb_build_object('sms',p_notify_sms,'email',p_notify_email);
  v_request_material:=pg_catalog.jsonb_build_object(
    'salon_id',p_salon_id,'staff_id',p_staff_id,'request_id',p_request_id,
    'actor_user_id',p_actor_user_id,'actor_role',p_actor_role,
    'assignments',v_assignments,'requested_channels',v_channels,
    'revoke_access',p_revoke_access,
    'notification_delay_seconds',p_notification_delay_seconds
  );
  v_assignment_fingerprint:=pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_request_material::text,'UTF8'),'sha256'),'hex');

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'staff-offboarding:'||p_salon_id::text,0));

  SELECT s.* INTO v_salon FROM public.salons s
  WHERE s.id=p_salon_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','not_found');
  END IF;
  IF p_actor_user_id IS NULL THEN
    IF p_actor_role<>'demo_cookie' OR p_notify_email OR p_notify_sms THEN
      RETURN pg_catalog.jsonb_build_object('success',false,'code','actor_unauthorized');
    END IF;
    v_actor_role:='demo_cookie';
  ELSE
    SELECT m.role INTO v_actor_role FROM public.salon_members m
    WHERE m.salon_id=p_salon_id AND m.user_id=p_actor_user_id
      AND m.role IN ('owner','admin')
    FOR UPDATE;
    IF v_actor_role IS NULL OR v_actor_role IS DISTINCT FROM p_actor_role THEN
      RETURN pg_catalog.jsonb_build_object('success',false,'code','actor_unauthorized');
    END IF;
  END IF;

  SELECT * INTO v_receipt FROM public.staff_offboarding_receipts r
  WHERE r.salon_id=p_salon_id AND r.request_id=p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_receipt.staff_id IS DISTINCT FROM p_staff_id
       OR v_receipt.actor_user_id IS DISTINCT FROM p_actor_user_id
       OR v_receipt.actor_role IS DISTINCT FROM v_actor_role
       OR v_receipt.requested_channels IS DISTINCT FROM v_channels
       OR v_receipt.revoke_access IS DISTINCT FROM p_revoke_access
       OR v_receipt.assignment_fingerprint IS DISTINCT FROM v_assignment_fingerprint
       OR v_receipt.result_fingerprint IS DISTINCT FROM pg_catalog.encode(
         extensions.digest(pg_catalog.convert_to(v_receipt.result_json::text,'UTF8'),'sha256'),'hex') THEN
      RETURN pg_catalog.jsonb_build_object('success',false,'code','idempotency_mismatch');
    END IF;
    v_audit_count:=public.ensure_staff_offboarding_booking_events(
      p_salon_id,p_staff_id,p_request_id,p_actor_user_id,v_actor_role,
      v_receipt.result_json
    );
    RETURN v_receipt.result_json||pg_catalog.jsonb_build_object(
      'idempotent',true,'audit_events_recorded',v_audit_count
    );
  END IF;

  IF (p_notify_email AND v_salon.email_outbound_enabled IS NOT TRUE)
     OR (p_notify_sms AND v_salon.sms_outbound_enabled IS NOT TRUE) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'code','notification_channel_unavailable',
      'email_outbound_enabled',v_salon.email_outbound_enabled,
      'sms_outbound_enabled',v_salon.sms_outbound_enabled
    );
  END IF;

  SELECT * INTO v_target FROM public.staff s
  WHERE s.id=p_staff_id AND s.salon_id=p_salon_id AND s.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('success',false,'code','not_found'); END IF;
  IF v_target.status='inactive' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','already_inactive');
  END IF;
  IF v_target.status<>'active' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','stale_staff');
  END IF;
  IF v_target.user_id IS NOT NULL THEN
    PERFORM 1 FROM public.salon_members m
    WHERE m.salon_id=p_salon_id AND m.user_id=v_target.user_id
    FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM public.salon_members m
      WHERE m.salon_id=p_salon_id AND m.user_id=v_target.user_id AND m.role='owner'
    ) THEN
      RETURN pg_catalog.jsonb_build_object('success',false,'code','owner_access_protected');
    END IF;
  END IF;
  IF (SELECT count(*) FROM public.staff s
      WHERE s.salon_id=p_salon_id AND s.id<>p_staff_id
        AND s.status='active' AND s.deleted_at IS NULL)<1 THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','minimum_active_staff');
  END IF;

  SELECT coalesce(pg_catalog.array_agg(b.id ORDER BY b.id),'{}'::uuid[])
  INTO v_affected_booking_ids
  FROM public.bookings b
  WHERE b.salon_id=p_salon_id AND b.deleted_at IS NULL
    AND b.status IN ('pending','confirmed','in_progress','waiting')
    AND (
      (b.schedule_model='single' AND b.staff_id=p_staff_id)
      OR (
        b.schedule_model='segments_v1'
        AND EXISTS (
          SELECT 1 FROM public.booking_service_segments seg
          WHERE seg.booking_id=b.id AND seg.salon_id=p_salon_id
            AND seg.staff_id=p_staff_id
            AND seg.reservation_status IN ('pending','confirmed','in_progress','waiting')
        )
      )
    );
  v_reassignable_count:=pg_catalog.cardinality(v_affected_booking_ids);
  IF v_reassignable_count>100 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'code','too_many_bookings','limit',100,
      'affected_count',v_reassignable_count
    );
  END IF;

  PERFORM 1 FROM public.bookings b
  WHERE b.id=ANY(v_affected_booking_ids) ORDER BY b.id FOR UPDATE;
  PERFORM 1 FROM public.booking_service_segments seg
  WHERE seg.booking_id=ANY(v_affected_booking_ids)
  ORDER BY seg.booking_id,seg.position FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.id=ANY(v_affected_booking_ids)
      AND b.status IN ('in_progress','waiting')
  ) OR EXISTS (
    SELECT 1 FROM public.booking_service_segments seg
    WHERE seg.booking_id=ANY(v_affected_booking_ids)
      AND seg.staff_id=p_staff_id
      AND seg.reservation_status IN ('in_progress','waiting')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','operational_booking_blocked');
  END IF;

  IF v_reassignable_count<>pg_catalog.jsonb_array_length(v_assignments)
     OR EXISTS (
       SELECT 1 FROM pg_catalog.unnest(v_affected_booking_ids) booking_id
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_assignments)
           AS a(booking_id uuid,staff_id uuid)
         WHERE a.booking_id=booking_id
       )
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_assignments)
         AS a(booking_id uuid,staff_id uuid)
       WHERE NOT (a.booking_id=ANY(v_affected_booking_ids))
     ) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','assign_every_booking');
  END IF;

  PERFORM 1 FROM public.staff s
  WHERE s.id IN (
    SELECT a.staff_id FROM pg_catalog.jsonb_to_recordset(v_assignments)
      AS a(booking_id uuid,staff_id uuid)
  ) ORDER BY s.id FOR KEY SHARE;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_assignments)
      AS a(booking_id uuid,staff_id uuid)
    LEFT JOIN public.staff s ON s.id=a.staff_id AND s.salon_id=p_salon_id
      AND s.status='active' AND s.deleted_at IS NULL
    WHERE s.id IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','candidate_unavailable');
  END IF;

  -- Hold configured capability rows stable until commit. Empty mappings among
  -- active salon staff retain the documented all-capable fallback.
  PERFORM 1 FROM public.staff_services ss
  JOIN public.staff st ON st.id=ss.staff_id
  WHERE st.salon_id=p_salon_id AND st.status='active' AND st.deleted_at IS NULL
  ORDER BY ss.staff_id,ss.service_id FOR SHARE;
  IF EXISTS (
      SELECT 1 FROM public.staff_services configured
      JOIN public.staff configured_staff ON configured_staff.id=configured.staff_id
      WHERE configured_staff.salon_id=p_salon_id
        AND configured_staff.status='active'
        AND configured_staff.deleted_at IS NULL
    ) AND EXISTS (
      WITH assignment_rows AS (
        SELECT * FROM pg_catalog.jsonb_to_recordset(v_assignments)
          AS a(booking_id uuid,staff_id uuid)
      ), required_services AS (
        SELECT a.booking_id,a.staff_id,b.service_id
        FROM assignment_rows a JOIN public.bookings b ON b.id=a.booking_id
        WHERE b.schedule_model='single'
        UNION
        SELECT a.booking_id,a.staff_id,b.addon_service_id
        FROM assignment_rows a JOIN public.bookings b ON b.id=a.booking_id
        WHERE b.schedule_model='single' AND b.addon_service_id IS NOT NULL
        UNION
        SELECT a.booking_id,a.staff_id,seg.service_id
        FROM assignment_rows a
        JOIN public.booking_service_segments seg ON seg.booking_id=a.booking_id
        WHERE seg.staff_id=p_staff_id
          AND seg.reservation_status IN ('pending','confirmed')
        UNION
        SELECT a.booking_id,a.staff_id,(addon.value->>'service_id')::uuid
        FROM assignment_rows a
        JOIN public.booking_service_segments seg ON seg.booking_id=a.booking_id
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(seg.addon_lines) addon(value)
        WHERE seg.staff_id=p_staff_id
          AND seg.reservation_status IN ('pending','confirmed')
      )
      SELECT 1 FROM required_services required
      WHERE NOT EXISTS (
        SELECT 1 FROM public.staff_services ss
        WHERE ss.staff_id=required.staff_id AND ss.service_id=required.service_id
      )
    ) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','candidate_unavailable');
  END IF;

  -- Explicit conflict preflight for both scheduling models. Exclusion and
  -- cross-model constraints remain authoritative for a last-moment race.
  IF EXISTS (
    WITH assignment_rows AS (
      SELECT * FROM pg_catalog.jsonb_to_recordset(v_assignments)
        AS a(booking_id uuid,staff_id uuid)
    ), target_ranges AS (
      SELECT a.booking_id,a.staff_id,b.start_time_utc AS start_at,b.end_time_utc AS end_at
      FROM assignment_rows a JOIN public.bookings b ON b.id=a.booking_id
      WHERE b.schedule_model='single'
      UNION ALL
      SELECT a.booking_id,a.staff_id,seg.occupied_start_utc,seg.occupied_end_utc
      FROM assignment_rows a
      JOIN public.booking_service_segments seg ON seg.booking_id=a.booking_id
      WHERE seg.staff_id=p_staff_id
        AND seg.reservation_status IN ('pending','confirmed')
    )
    SELECT 1 FROM target_ranges target
    WHERE EXISTS (
      SELECT 1 FROM public.bookings other
      WHERE other.salon_id=p_salon_id AND other.schedule_model='single'
        AND other.staff_id=target.staff_id AND other.id<>target.booking_id
        AND other.deleted_at IS NULL
        AND other.status NOT IN ('cancelled','no_show','completed')
        AND pg_catalog.tstzrange(other.start_time_utc,other.end_time_utc,'[)')
          && pg_catalog.tstzrange(target.start_at,target.end_at,'[)')
    ) OR EXISTS (
      SELECT 1 FROM public.booking_service_segments other
      WHERE other.salon_id=p_salon_id AND other.staff_id=target.staff_id
        AND other.reservation_status NOT IN ('cancelled','no_show','completed')
        AND pg_catalog.tstzrange(other.occupied_start_utc,other.occupied_end_utc,'[)')
          && pg_catalog.tstzrange(target.start_at,target.end_at,'[)')
    )
  ) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','candidate_unavailable');
  END IF;

  FOR v_assignment IN
    SELECT * FROM pg_catalog.jsonb_to_recordset(v_assignments)
      AS a(booking_id uuid,staff_id uuid) ORDER BY booking_id
  LOOP
    SELECT b.* INTO STRICT v_booking FROM public.bookings b
    WHERE b.id=v_assignment.booking_id AND b.salon_id=p_salon_id FOR UPDATE;
    SELECT st.name INTO STRICT v_replacement_name FROM public.staff st
    WHERE st.id=v_assignment.staff_id AND st.salon_id=p_salon_id
      AND st.status='active' AND st.deleted_at IS NULL;

    IF v_booking.schedule_model='single' THEN
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
          AND schedule_model='single' AND staff_id=p_staff_id
          AND status IN ('pending','confirmed') AND deleted_at IS NULL;
      ELSE
        UPDATE public.bookings SET staff_id=v_assignment.staff_id
        WHERE id=v_assignment.booking_id AND salon_id=p_salon_id
          AND schedule_model='single' AND staff_id=p_staff_id
          AND status IN ('pending','confirmed') AND deleted_at IS NULL;
      END IF;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'atomic single staff offboarding booking changed'
          USING ERRCODE='NI002';
      END IF;
      v_enriched_assignments:=v_enriched_assignments||pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'booking_id',v_assignment.booking_id,'staff_id',v_assignment.staff_id,
          'schedule_model','single','affected_segment_ids','[]'::jsonb
        )
      );
    ELSIF v_booking.schedule_model='segments_v1' THEN
      SELECT
        coalesce(pg_catalog.jsonb_agg(seg.id ORDER BY seg.position),'[]'::jsonb),
        coalesce(pg_catalog.jsonb_agg(seg.line_id ORDER BY seg.position),'[]'::jsonb)
      INTO v_affected_segment_ids,v_affected_line_ids
      FROM public.booking_service_segments seg
      WHERE seg.booking_id=v_booking.id AND seg.salon_id=p_salon_id
        AND seg.staff_id=p_staff_id
        AND seg.reservation_status IN ('pending','confirmed');
      IF pg_catalog.jsonb_array_length(v_affected_segment_ids)<1
         OR pg_catalog.jsonb_typeof(v_booking.public_booking_pricing_snapshot)<>'object'
         OR pg_catalog.jsonb_typeof(v_booking.public_booking_pricing_snapshot->'segments')<>'array'
         OR pg_catalog.jsonb_typeof(v_booking.public_booking_pricing_snapshot->'timing_segments')<>'array'
         OR pg_catalog.jsonb_typeof(v_booking.public_booking_pricing_snapshot->'reschedule_intent')<>'object'
         OR pg_catalog.jsonb_typeof(v_booking.public_booking_pricing_snapshot#>'{reschedule_intent,lines}')<>'array'
         OR (SELECT count(*) FROM public.booking_service_segments seg
             WHERE seg.booking_id=v_booking.id)<>
            pg_catalog.jsonb_array_length(v_booking.public_booking_pricing_snapshot->'segments') THEN
        RAISE EXCEPTION 'staff offboarding sequence receipt invalid'
          USING ERRCODE='NI003';
      END IF;

      SELECT coalesce(pg_catalog.jsonb_agg(
        CASE WHEN line.value->'line_id' <@ v_affected_line_ids THEN
          line.value||pg_catalog.jsonb_build_object(
            'staff_id',v_assignment.staff_id,
            'resolved_staff_id',v_assignment.staff_id,
            'staff_name',v_replacement_name
          ) ELSE line.value END
        ORDER BY (line.value->>'position')::integer
      ),'[]'::jsonb) INTO v_new_segments
      FROM pg_catalog.jsonb_array_elements(
        v_booking.public_booking_pricing_snapshot->'segments'
      ) line(value);

      SELECT coalesce(pg_catalog.jsonb_agg(
        CASE WHEN line.value->'line_id' <@ v_affected_line_ids THEN
          line.value||pg_catalog.jsonb_build_object(
            'resolved_staff_id',v_assignment.staff_id
          ) ELSE line.value END
        ORDER BY (line.value->>'position')::integer
      ),'[]'::jsonb) INTO v_new_timing_segments
      FROM pg_catalog.jsonb_array_elements(
        v_booking.public_booking_pricing_snapshot->'timing_segments'
      ) line(value);

      SELECT coalesce(pg_catalog.jsonb_agg(
        CASE WHEN line.value->'line_id' <@ v_affected_line_ids THEN
          line.value||pg_catalog.jsonb_build_object(
            'staff_preference',v_assignment.staff_id
          ) ELSE line.value END
        ORDER BY (line.value->>'position')::integer
      ),'[]'::jsonb) INTO v_new_intent_lines
      FROM pg_catalog.jsonb_array_elements(
        v_booking.public_booking_pricing_snapshot#>'{reschedule_intent,lines}'
      ) line(value);

      IF pg_catalog.jsonb_array_length(v_new_segments)<>
           pg_catalog.jsonb_array_length(v_booking.public_booking_pricing_snapshot->'segments')
         OR pg_catalog.jsonb_array_length(v_new_timing_segments)<>
           pg_catalog.jsonb_array_length(v_booking.public_booking_pricing_snapshot->'timing_segments')
         OR pg_catalog.jsonb_array_length(v_new_intent_lines)<>
           pg_catalog.jsonb_array_length(v_booking.public_booking_pricing_snapshot#>'{reschedule_intent,lines}') THEN
        RAISE EXCEPTION 'staff offboarding sequence receipt invalid'
          USING ERRCODE='NI003';
      END IF;

      v_new_snapshot:=v_booking.public_booking_pricing_snapshot||pg_catalog.jsonb_build_object(
        'segments',v_new_segments,
        'timing_segments',v_new_timing_segments,
        'reschedule_intent',(v_booking.public_booking_pricing_snapshot->'reschedule_intent')
          ||pg_catalog.jsonb_build_object('lines',v_new_intent_lines)
      );
      v_fingerprint_material:=v_new_snapshot-
        ARRAY['success','code','request_id','pricing_fingerprint']::text[];
      v_new_pricing_fingerprint:=pg_catalog.encode(extensions.digest(
        pg_catalog.convert_to(v_fingerprint_material::text,'UTF8'),'sha256'),'hex');
      v_new_snapshot:=v_new_snapshot||pg_catalog.jsonb_build_object(
        'pricing_fingerprint',v_new_pricing_fingerprint
      );

      PERFORM pg_catalog.set_config(
        'nailiq.sequence_reschedule_booking_id',v_booking.id::text,true
      );
      UPDATE public.booking_service_segments seg SET
        staff_id=v_assignment.staff_id,staff_name=v_replacement_name
      WHERE seg.booking_id=v_booking.id AND seg.salon_id=p_salon_id
        AND seg.id IN (
          SELECT value::uuid
          FROM pg_catalog.jsonb_array_elements_text(v_affected_segment_ids)
        ) AND seg.staff_id=p_staff_id
        AND seg.reservation_status IN ('pending','confirmed');
      IF NOT FOUND OR (SELECT count(*) FROM public.booking_service_segments seg
        WHERE seg.booking_id=v_booking.id AND seg.id IN (
          SELECT value::uuid
          FROM pg_catalog.jsonb_array_elements_text(v_affected_segment_ids)
        ) AND seg.staff_id=v_assignment.staff_id)<>
          pg_catalog.jsonb_array_length(v_affected_segment_ids) THEN
        RAISE EXCEPTION 'atomic sequence staff offboarding segment changed'
          USING ERRCODE='NI002';
      END IF;

      IF p_notify_email OR p_notify_sms THEN
        v_notification_request_id:=public.staff_offboarding_notification_request_id(
          p_request_id,v_assignment.booking_id);
        PERFORM pg_catalog.set_config(
          'nailiq.staff_change_force_booking_id',v_booking.id::text,true
        );
        PERFORM pg_catalog.set_config(
          'nailiq.staff_change_previous_staff_id',p_staff_id::text,true
        );
        PERFORM pg_catalog.set_config(
          'nailiq.staff_change_replacement_staff_id',v_assignment.staff_id::text,true
        );
        PERFORM pg_catalog.set_config(
          'nailiq.staff_change_affected_segment_ids',v_affected_segment_ids::text,true
        );
      END IF;

      UPDATE public.bookings b SET
        service_id=first_seg.service_id,
        staff_id=first_seg.staff_id,
        resource_id=first_seg.resource_id,
        public_booking_pricing_fingerprint=v_new_pricing_fingerprint,
        public_booking_pricing_snapshot=v_new_snapshot,
        staff_action_notification_request_id=CASE WHEN p_notify_email OR p_notify_sms
          THEN v_notification_request_id ELSE NULL END,
        staff_action_notification_actor_user_id=CASE WHEN p_notify_email OR p_notify_sms
          THEN p_actor_user_id ELSE NULL END,
        staff_action_notification_actor_role=CASE WHEN p_notify_email OR p_notify_sms
          THEN v_actor_role ELSE NULL END,
        staff_action_notification_channels=CASE WHEN p_notify_email OR p_notify_sms
          THEN v_channels ELSE NULL END,
        staff_action_notification_delay_seconds=CASE WHEN p_notify_email OR p_notify_sms
          THEN p_notification_delay_seconds ELSE NULL END
      FROM public.booking_service_segments first_seg
      WHERE b.id=v_booking.id AND b.salon_id=p_salon_id
        AND first_seg.booking_id=b.id AND first_seg.position=0;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'atomic sequence staff offboarding parent changed'
          USING ERRCODE='NI002';
      END IF;
      SET CONSTRAINTS check_booking_service_sequence_shape IMMEDIATE;
      SET CONSTRAINTS check_booking_service_sequence_shape DEFERRED;
      PERFORM pg_catalog.set_config('nailiq.sequence_reschedule_booking_id','',true);
      PERFORM pg_catalog.set_config('nailiq.staff_change_force_booking_id','',true);
      PERFORM pg_catalog.set_config('nailiq.staff_change_previous_staff_id','',true);
      PERFORM pg_catalog.set_config('nailiq.staff_change_replacement_staff_id','',true);
      PERFORM pg_catalog.set_config('nailiq.staff_change_affected_segment_ids','',true);

      v_enriched_assignments:=v_enriched_assignments||pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'booking_id',v_assignment.booking_id,'staff_id',v_assignment.staff_id,
          'schedule_model','segments_v1',
          'affected_segment_ids',v_affected_segment_ids
        )
      );
    ELSE
      RAISE EXCEPTION 'staff offboarding schedule model changed'
        USING ERRCODE='NI004';
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
    FROM pg_catalog.jsonb_to_recordset(v_assignments) AS a(booking_id uuid,staff_id uuid)
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

  v_result:=pg_catalog.jsonb_build_object(
    'success',true,'code','staff_offboarded','idempotent',false,
    'salon_id',p_salon_id,'staff_id',p_staff_id,'request_id',p_request_id,
    'reassigned_count',v_reassignable_count,'assignments',v_enriched_assignments,
    'notification_events_queued',v_outbox_count,
    'notification_deliveries_queued',v_delivery_count,
    'requested_channels',v_channels,'access_revoked',v_access_revoked
  );
  v_audit_count:=public.ensure_staff_offboarding_booking_events(
    p_salon_id,p_staff_id,p_request_id,p_actor_user_id,v_actor_role,v_result
  );
  v_result:=v_result||pg_catalog.jsonb_build_object(
    'audit_events_recorded',v_audit_count
  );
  v_result_fingerprint:=pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_result::text,'UTF8'),'sha256'),'hex');
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
    RETURN pg_catalog.jsonb_build_object('success',false,'code','candidate_unavailable');
  WHEN SQLSTATE 'NI003' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','sequence_receipt_invalid');
  WHEN SQLSTATE 'NI004' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','stale_booking');
END;
$offboard$;

-- Lost-response recovery intentionally accepts no assignment or notification
-- overrides. It can only return an exact, fingerprint-verified receipt for the
-- same salon, staff and actor, and repairs/proves its canonical audit rows.
CREATE OR REPLACE FUNCTION public.recover_staff_offboarding_with_durable_notifications(
  p_salon_id uuid,p_staff_id uuid,p_request_id uuid,p_actor_user_id uuid,
  p_actor_role text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $recover$
DECLARE
  v_receipt public.staff_offboarding_receipts%ROWTYPE;
  v_actor_role text;
  v_audit_count integer;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_staff_id IS NULL OR p_request_id IS NULL
     OR p_actor_role IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'staff-offboarding:'||p_salon_id::text,0));
  IF p_actor_user_id IS NULL THEN
    IF p_actor_role<>'demo_cookie' THEN
      RETURN pg_catalog.jsonb_build_object('success',false,'code','actor_unauthorized');
    END IF;
    v_actor_role:='demo_cookie';
  ELSE
    SELECT m.role INTO v_actor_role FROM public.salon_members m
    WHERE m.salon_id=p_salon_id AND m.user_id=p_actor_user_id
      AND m.role IN ('owner','admin') FOR UPDATE;
    IF v_actor_role IS NULL OR v_actor_role IS DISTINCT FROM p_actor_role THEN
      RETURN pg_catalog.jsonb_build_object('success',false,'code','actor_unauthorized');
    END IF;
  END IF;
  SELECT * INTO v_receipt FROM public.staff_offboarding_receipts r
  WHERE r.salon_id=p_salon_id AND r.request_id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','replay_not_found');
  END IF;
  IF v_receipt.staff_id IS DISTINCT FROM p_staff_id
     OR v_receipt.actor_user_id IS DISTINCT FROM p_actor_user_id
     OR v_receipt.actor_role IS DISTINCT FROM v_actor_role
     OR v_receipt.result_fingerprint IS DISTINCT FROM pg_catalog.encode(
       extensions.digest(pg_catalog.convert_to(v_receipt.result_json::text,'UTF8'),'sha256'),'hex')
     OR v_receipt.result_json->>'request_id' IS DISTINCT FROM p_request_id::text
     OR coalesce((v_receipt.result_json->>'success')::boolean,false) IS NOT TRUE THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','idempotency_mismatch');
  END IF;
  v_audit_count:=public.ensure_staff_offboarding_booking_events(
    p_salon_id,p_staff_id,p_request_id,p_actor_user_id,v_actor_role,
    v_receipt.result_json
  );
  RETURN v_receipt.result_json||pg_catalog.jsonb_build_object(
    'idempotent',true,'audit_events_recorded',v_audit_count
  );
END;
$recover$;

REVOKE ALL ON FUNCTION public.offboard_staff_with_durable_notifications(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.offboard_staff_with_durable_notifications(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
) TO service_role;

REVOKE ALL ON FUNCTION public.recover_staff_offboarding_with_durable_notifications(
  uuid,uuid,uuid,uuid,text
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.recover_staff_offboarding_with_durable_notifications(
  uuid,uuid,uuid,uuid,text
) TO service_role;

COMMENT ON FUNCTION public.offboard_staff_with_durable_notifications(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
) IS 'Service-role-only atomic sequence-aware staff offboarding, exact audit/outbox receipt and replay; never calls a provider.';

COMMENT ON FUNCTION public.recover_staff_offboarding_with_durable_notifications(
  uuid,uuid,uuid,uuid,text
) IS 'Service-role-only lost-response recovery for a fingerprint-verified staff-offboarding receipt and canonical audit rows.';

-- Durable, provider-agnostic staff-action customer notification outbox.
-- Staff create/reschedule/cancel writes opt in through ephemeral booking inputs;
-- the capture trigger clears those inputs and records the immutable occurrence
-- in the same transaction as the booking mutation. Provider work remains inert
-- until a service worker materializes and leases an exact SMS/email envelope.

ALTER TABLE public.bookings
  ADD COLUMN staff_action_notification_request_id uuid,
  ADD COLUMN staff_action_notification_actor_user_id uuid,
  ADD COLUMN staff_action_notification_actor_role text,
  ADD COLUMN staff_action_notification_channels jsonb,
  ADD COLUMN staff_action_notification_delay_seconds integer;

ALTER TABLE public.bookings ADD CONSTRAINT bookings_staff_action_inputs_ephemeral_check
  CHECK (
    staff_action_notification_request_id IS NULL
    AND staff_action_notification_actor_user_id IS NULL
    AND staff_action_notification_actor_role IS NULL
    AND staff_action_notification_channels IS NULL
    AND staff_action_notification_delay_seconds IS NULL
  ) NOT VALID;

COMMENT ON COLUMN public.bookings.staff_action_notification_request_id IS
  'Ephemeral service-role-only staff notification input; capture trigger always clears before storage.';

CREATE TABLE public.staff_action_notification_outbox (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL,
  request_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('create','reschedule','cancel')),
  occurrence_version bigint NOT NULL CHECK (occurrence_version >= 0),
  actor_user_id uuid,
  actor_role text NOT NULL CHECK (
    length(actor_role) BETWEEN 2 AND 40 AND actor_role ~ '^[a-z][a-z0-9_]*$'
  ),
  requested_channels jsonb NOT NULL CHECK (
    jsonb_typeof(requested_channels)='object'
    AND requested_channels ? 'sms' AND requested_channels ? 'email'
    AND jsonb_typeof(requested_channels->'sms')='boolean'
    AND jsonb_typeof(requested_channels->'email')='boolean'
  ),
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot)='object'),
  material_snapshot jsonb CHECK (material_snapshot IS NULL OR jsonb_typeof(material_snapshot)='object'),
  material_fingerprint text NOT NULL CHECK (material_fingerprint ~ '^[0-9a-f]{64}$'),
  notification_delay_seconds integer NOT NULL CHECK (notification_delay_seconds BETWEEN 0 AND 120),
  send_after timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','completed')),
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT staff_action_notification_outbox_booking_fkey
    FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT staff_action_notification_outbox_request_once UNIQUE (salon_id,request_id),
  CONSTRAINT staff_action_notification_outbox_occurrence_once
    UNIQUE (booking_id,event_type,occurrence_version),
  CONSTRAINT staff_action_notification_outbox_actor_check CHECK (
    (actor_user_id IS NOT NULL AND actor_role NOT IN ('system','demo_cookie'))
    OR (actor_user_id IS NULL AND actor_role IN ('system','demo_cookie'))
  ),
  CONSTRAINT staff_action_notification_outbox_window_check CHECK (
    expires_at > send_after AND expires_at <= send_after + interval '30 minutes'
  )
);

CREATE TABLE public.staff_action_notification_deliveries (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES public.staff_action_notification_outbox(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms','email')),
  status text NOT NULL DEFAULT 'awaiting_material' CHECK (
    status IN ('awaiting_material','pending','sending','sent','failed','unknown','suppressed','cancelled')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
  attempt_token uuid,
  payload_fingerprint text CHECK (payload_fingerprint IS NULL OR payload_fingerprint ~ '^[0-9a-f]{64}$'),
  recipient_fingerprint text CHECK (recipient_fingerprint IS NULL OR recipient_fingerprint ~ '^[0-9a-f]{64}$'),
  claimed_at timestamptz,
  completed_at timestamptz,
  next_attempt_at timestamptz,
  failure_disposition text NOT NULL DEFAULT 'none' CHECK (
    failure_disposition IN ('none','retryable_pre_acceptance','permanent')
  ),
  provider_name text NOT NULL CHECK (provider_name IN ('twilio','resend')),
  provider_message_id text,
  error_code text CHECK (error_code IS NULL OR (
    length(error_code) <= 80 AND error_code !~ '[[:cntrl:]]'
  )),
  completion_fingerprint text CHECK (
    completion_fingerprint IS NULL OR completion_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  reconciliation_reason text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT staff_action_notification_delivery_channel_once UNIQUE (outbox_id,channel),
  CONSTRAINT staff_action_notification_deliveries_booking_fkey
    FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT staff_action_notification_delivery_state_check CHECK (
    (status='awaiting_material' AND attempt_count=0 AND attempt_token IS NULL
      AND payload_fingerprint IS NULL AND recipient_fingerprint IS NULL)
    OR (status='pending' AND attempt_count=0 AND attempt_token IS NULL
      AND payload_fingerprint IS NOT NULL AND recipient_fingerprint IS NOT NULL)
    OR (status='sending' AND attempt_count BETWEEN 1 AND 2 AND attempt_token IS NOT NULL
      AND claimed_at IS NOT NULL AND completed_at IS NULL
      AND payload_fingerprint IS NOT NULL AND recipient_fingerprint IS NOT NULL)
    OR (status IN ('sent','failed','unknown','suppressed','cancelled') AND completed_at IS NOT NULL)
  ),
  CONSTRAINT staff_action_notification_delivery_retry_check CHECK (
    next_attempt_at IS NULL OR (
      status='failed' AND failure_disposition='retryable_pre_acceptance'
      AND attempt_count < 2
    )
  ),
  CONSTRAINT staff_action_notification_delivery_receipt_check CHECK (
    status <> 'sent' OR (
      provider_message_id IS NOT NULL
      AND (
        (channel='sms' AND provider_message_id ~ '^(SM|MM)[0-9A-Fa-f]{32}$')
        OR (channel='email' AND length(provider_message_id)<=255
          AND provider_message_id !~ '[[:cntrl:]]')
      )
    )
  )
);

CREATE TABLE public.staff_action_notification_envelopes (
  delivery_id uuid PRIMARY KEY
    REFERENCES public.staff_action_notification_deliveries(id) ON DELETE CASCADE,
  contract_version smallint NOT NULL DEFAULT 1 CHECK (contract_version=1),
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  recipient_fingerprint text NOT NULL CHECK (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
  dispatch_envelope text NOT NULL CHECK (octet_length(dispatch_envelope) BETWEEN 1 AND 262144),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

-- Group cancellation needs a durable action receipt even when both customer
-- notification channels are intentionally off. It contains no recipient or
-- rendered message material.
CREATE TABLE public.staff_action_group_cancel_receipts (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  request_id uuid NOT NULL,
  organizer_booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('owner','admin','senior','receptionist')),
  requested_channels jsonb NOT NULL CHECK (
    jsonb_typeof(requested_channels)='object'
    AND requested_channels ? 'sms' AND requested_channels ? 'email'
    AND jsonb_typeof(requested_channels->'sms')='boolean'
    AND jsonb_typeof(requested_channels->'email')='boolean'
  ),
  notification_delay_seconds integer NOT NULL CHECK (notification_delay_seconds BETWEEN 0 AND 120),
  cancelled_booking_ids jsonb NOT NULL CHECK (
    jsonb_typeof(cancelled_booking_ids)='array' AND jsonb_array_length(cancelled_booking_ids)>0
  ),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json)='object'),
  result_fingerprint text NOT NULL CHECK (result_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT staff_action_group_cancel_request_once UNIQUE(salon_id,request_id),
  CONSTRAINT staff_action_group_cancel_occurrence_once UNIQUE(salon_id,group_id,request_id)
);

CREATE INDEX staff_action_notification_outbox_salon_created_idx
  ON public.staff_action_notification_outbox(salon_id,created_at DESC,id);
CREATE INDEX staff_action_notification_deliveries_material_idx
  ON public.staff_action_notification_deliveries(created_at,id)
  WHERE status='awaiting_material';
CREATE INDEX staff_action_notification_deliveries_due_idx
  ON public.staff_action_notification_deliveries(coalesce(next_attempt_at,created_at),id)
  WHERE status='pending' OR (
    status='failed' AND failure_disposition='retryable_pre_acceptance' AND attempt_count<2
  );

ALTER TABLE public.staff_action_notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_action_notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_action_notification_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_action_group_cancel_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.staff_action_notification_outbox,
  public.staff_action_notification_deliveries,
  public.staff_action_notification_envelopes,
  public.staff_action_group_cancel_receipts
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.staff_action_notification_outbox,
  public.staff_action_notification_deliveries,
  public.staff_action_notification_envelopes,
  public.staff_action_group_cancel_receipts TO service_role;
CREATE POLICY "deny browser access to staff action notification outbox"
  ON public.staff_action_notification_outbox AS RESTRICTIVE
  FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY "deny browser access to staff action notification deliveries"
  ON public.staff_action_notification_deliveries AS RESTRICTIVE
  FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY "deny browser access to staff action notification envelopes"
  ON public.staff_action_notification_envelopes AS RESTRICTIVE
  FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY "deny browser access to staff action group cancel receipts"
  ON public.staff_action_group_cancel_receipts AS RESTRICTIVE
  FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

CREATE FUNCTION public.staff_action_notification_caller_is_service_role()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO '' AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',
    nullif(current_setting('role',true),'')
  )='service_role'
$$;

CREATE FUNCTION public.capture_staff_action_notification_occurrence()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $capture$
DECLARE
  v_request_id uuid;
  v_actor_user_id uuid;
  v_actor_role text;
  v_channels jsonb;
  v_delay integer;
  v_event text;
  v_occurrence bigint;
  v_salon public.salons%ROWTYPE;
  v_service_name text;
  v_staff_name text;
  v_snapshot jsonb;
  v_result_snapshot jsonb;
  v_affected_booking_ids jsonb;
  v_fingerprint text;
  v_outbox public.staff_action_notification_outbox%ROWTYPE;
  v_existing public.staff_action_notification_outbox%ROWTYPE;
  v_now timestamptz:=transaction_timestamp();
  v_setting text;
BEGIN
  v_request_id:=NEW.staff_action_notification_request_id;
  v_actor_user_id:=NEW.staff_action_notification_actor_user_id;
  v_actor_role:=nullif(trim(coalesce(NEW.staff_action_notification_actor_role,'')),'');
  v_channels:=NEW.staff_action_notification_channels;
  v_delay:=NEW.staff_action_notification_delay_seconds;

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
  v_setting:=nullif(current_setting('nailiq.staff_action_affected_booking_ids',true),'');
  IF v_setting IS NOT NULL THEN v_affected_booking_ids:=v_setting::jsonb; END IF;

  -- Inputs are never persisted on the booking row.
  NEW.staff_action_notification_request_id:=NULL;
  NEW.staff_action_notification_actor_user_id:=NULL;
  NEW.staff_action_notification_actor_role:=NULL;
  NEW.staff_action_notification_channels:=NULL;
  NEW.staff_action_notification_delay_seconds:=NULL;

  -- Canonical mutations can write the same booking more than once. Consume a
  -- wrapper's transaction-local inputs on the first occurrence so follow-up
  -- bookkeeping updates cannot manufacture a second notification event.
  IF v_request_id IS NOT NULL OR v_channels IS NOT NULL THEN
    PERFORM pg_catalog.set_config('nailiq.staff_action_request_id','',true);
    PERFORM pg_catalog.set_config('nailiq.staff_action_actor_user_id','',true);
    PERFORM pg_catalog.set_config('nailiq.staff_action_actor_role','',true);
    PERFORM pg_catalog.set_config('nailiq.staff_action_channels','',true);
    PERFORM pg_catalog.set_config('nailiq.staff_action_delay_seconds','',true);
    PERFORM pg_catalog.set_config('nailiq.staff_action_affected_booking_ids','',true);
  END IF;

  IF TG_OP='UPDATE' AND OLD.status='cancelled' AND NEW.status IS DISTINCT FROM 'cancelled' THEN
    UPDATE public.staff_action_notification_outbox o SET
      status='cancelled',cancelled_at=v_now,cancellation_reason='booking_cancel_undone',updated_at=v_now
    WHERE o.booking_id=NEW.id AND o.event_type='cancel'
      AND o.occurrence_version=OLD.customer_transition_version AND o.status='active';
    UPDATE public.staff_action_notification_deliveries d SET
      status='cancelled',completed_at=v_now,updated_at=v_now,
      failure_disposition='permanent',next_attempt_at=NULL,
      error_code='booking_cancel_undone',reconciliation_reason='booking_cancel_undone'
    FROM public.staff_action_notification_outbox o
    WHERE o.id=d.outbox_id AND o.booking_id=NEW.id AND o.event_type='cancel'
      AND o.occurrence_version=OLD.customer_transition_version
      AND d.status IN ('awaiting_material','pending','failed');
    RETURN NEW;
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
    RAISE EXCEPTION 'invalid staff action notification inputs' USING ERRCODE='check_violation';
  END IF;

  IF TG_OP='INSERT' THEN
    v_event:='create'; v_occurrence:=0;
  ELSIF NEW.status='cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    v_event:='cancel'; v_occurrence:=NEW.customer_transition_version;
  ELSIF NEW.start_time_utc IS DISTINCT FROM OLD.start_time_utc THEN
    v_event:='reschedule'; v_occurrence:=NEW.customer_transition_version;
  ELSE
    RAISE EXCEPTION 'staff notification requested without create/reschedule/cancel occurrence'
      USING ERRCODE='check_violation';
  END IF;

  IF v_affected_booking_ids IS NULL THEN
    v_affected_booking_ids:=jsonb_build_array(NEW.id);
  END IF;
  IF jsonb_typeof(v_affected_booking_ids)<>'array'
     OR jsonb_array_length(v_affected_booking_ids)<1
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(v_affected_booking_ids) x(value)
       WHERE x.value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     ) THEN
    RAISE EXCEPTION 'invalid affected booking receipt' USING ERRCODE='check_violation';
  END IF;
  v_result_snapshot:=jsonb_build_object(
    'salon_id',NEW.salon_id,'booking_id',NEW.id,'group_id',NEW.group_id,
    'event',v_event,'occurrence_version',v_occurrence,
    'booking_ids',v_affected_booking_ids,
    'affected_count',jsonb_array_length(v_affected_booking_ids)
  );

  IF v_actor_user_id IS NULL THEN
    IF v_actor_role NOT IN ('system','demo_cookie') THEN
      RAISE EXCEPTION 'staff notification actor missing' USING ERRCODE='check_violation';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.salon_members m
    WHERE m.salon_id=NEW.salon_id AND m.user_id=v_actor_user_id AND m.role=v_actor_role
      AND m.role IN ('owner','admin','senior','receptionist','nail_tech')
  ) THEN
    RAISE EXCEPTION 'staff notification actor unauthorized' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT s.* INTO STRICT v_salon FROM public.salons s WHERE s.id=NEW.salon_id FOR SHARE;
  SELECT sv.name INTO STRICT v_service_name FROM public.services sv
    WHERE sv.id=NEW.service_id AND sv.salon_id=NEW.salon_id;
  IF NEW.staff_id IS NOT NULL THEN
    SELECT st.name INTO v_staff_name FROM public.staff st
    WHERE st.id=NEW.staff_id AND st.salon_id=NEW.salon_id;
  END IF;
  v_snapshot:=jsonb_build_object(
    'contract_version',1,'salon_id',NEW.salon_id,'booking_id',NEW.id,
    'request_id',v_request_id,'event',v_event,'occurrence_version',v_occurrence,
    'actor_user_id',v_actor_user_id,'actor_role',v_actor_role,
    'client_name',coalesce(NEW.client_name,''),
    'client_phone',nullif(regexp_replace(coalesce(NEW.client_phone,''),'\D','','g'),''),
    'client_email',nullif(lower(trim(coalesce(NEW.client_email,''))),''),
    'locale',CASE lower(trim(split_part(coalesce(nullif(NEW.client_locale,''),
      nullif(v_salon.default_notification_locale,''),'en'),'-',1))) WHEN 'vi' THEN 'vi' ELSE 'en' END,
    'start_time_utc',NEW.start_time_utc,'service_id',NEW.service_id,
    'service_name',v_service_name,'staff_id',NEW.staff_id,'staff_name',v_staff_name,
    'salon_name',v_salon.name,'salon_slug',v_salon.slug,'salon_timezone',v_salon.timezone,
    'salon_phone',coalesce(nullif(v_salon.salon_phone,''),v_salon.phone),
    'salon_logo_url',v_salon.logo_url,
    'salon_is_test',(v_salon.slug ~* '^e2e[-_]' OR v_salon.name ~* '^e2e\y'),
    'sms_outbound_enabled',v_salon.sms_outbound_enabled,
    'email_outbound_enabled',v_salon.email_outbound_enabled,
    'requested_channels',v_channels
  )||jsonb_build_object('action_result',v_result_snapshot);
  v_fingerprint:=encode(extensions.digest(convert_to(v_snapshot::text,'UTF8'),'sha256'),'hex');

  INSERT INTO public.staff_action_notification_outbox(
    salon_id,booking_id,request_id,event_type,occurrence_version,
    actor_user_id,actor_role,requested_channels,result_snapshot,material_snapshot,material_fingerprint,
    notification_delay_seconds,
    send_after,expires_at
  ) VALUES (
    NEW.salon_id,NEW.id,v_request_id,v_event,v_occurrence,
    v_actor_user_id,v_actor_role,v_channels,v_result_snapshot,v_snapshot,v_fingerprint,v_delay,
    v_now+make_interval(secs=>v_delay),
    v_now+make_interval(secs=>v_delay)+interval '30 minutes'
  ) ON CONFLICT (salon_id,request_id) DO NOTHING
  RETURNING * INTO v_outbox;
  IF NOT FOUND THEN
    SELECT o.* INTO STRICT v_existing FROM public.staff_action_notification_outbox o
    WHERE o.salon_id=NEW.salon_id AND o.request_id=v_request_id FOR UPDATE;
    IF v_existing.booking_id<>NEW.id OR v_existing.event_type<>v_event
       OR v_existing.occurrence_version<>v_occurrence
       OR v_existing.material_fingerprint<>v_fingerprint THEN
      RAISE EXCEPTION 'staff notification idempotency conflict' USING ERRCODE='unique_violation';
    END IF;
    v_outbox:=v_existing;
  END IF;
  IF coalesce((v_channels->>'sms')::boolean,false) THEN
    INSERT INTO public.staff_action_notification_deliveries(
      outbox_id,salon_id,booking_id,channel,provider_name
    ) VALUES(v_outbox.id,NEW.salon_id,NEW.id,'sms','twilio') ON CONFLICT DO NOTHING;
  END IF;
  IF coalesce((v_channels->>'email')::boolean,false) THEN
    INSERT INTO public.staff_action_notification_deliveries(
      outbox_id,salon_id,booking_id,channel,provider_name
    ) VALUES(v_outbox.id,NEW.salon_id,NEW.id,'email','resend') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$capture$;

CREATE TRIGGER zz_capture_staff_action_notification_occurrence
BEFORE INSERT OR UPDATE ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.capture_staff_action_notification_occurrence();

CREATE FUNCTION public.discover_staff_action_notifications_awaiting_material(p_limit integer)
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $discover$
DECLARE v_limit integer:=least(greatest(coalesce(p_limit,0),0),100); v_row record;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() OR v_limit<1 THEN RETURN; END IF;
  FOR v_row IN
    SELECT o.id outbox_id,o.salon_id,o.booking_id,o.request_id,o.event_type,
      o.occurrence_version,o.actor_user_id,o.actor_role,o.material_snapshot,
      o.material_fingerprint,o.send_after,o.expires_at,
      jsonb_agg(jsonb_build_object('delivery_id',d.id,'channel',d.channel) ORDER BY d.channel) deliveries
    FROM public.staff_action_notification_outbox o
    JOIN public.staff_action_notification_deliveries d ON d.outbox_id=o.id
    WHERE o.status='active' AND o.material_snapshot IS NOT NULL
      AND d.status='awaiting_material'
    GROUP BY o.id
    ORDER BY o.created_at,o.id LIMIT v_limit
  LOOP RETURN NEXT jsonb_build_object(
    'success',true,'code','material_required','outbox_id',v_row.outbox_id,
    'salon_id',v_row.salon_id,'booking_id',v_row.booking_id,'request_id',v_row.request_id,
    'event',v_row.event_type,'occurrence_version',v_row.occurrence_version,
    'actor_user_id',v_row.actor_user_id,'actor_role',v_row.actor_role,
    'material',v_row.material_snapshot,'material_fingerprint',v_row.material_fingerprint,
    'send_after',v_row.send_after,'expires_at',v_row.expires_at,'deliveries',v_row.deliveries
  ); END LOOP;
END;$discover$;

CREATE FUNCTION public.load_staff_action_notification_material(p_delivery_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path TO '' AS $load$
DECLARE v_row record;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  SELECT d.id delivery_id,d.channel,d.status,o.* INTO v_row
  FROM public.staff_action_notification_deliveries d
  JOIN public.staff_action_notification_outbox o ON o.id=d.outbox_id
  WHERE d.id=p_delivery_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','delivery_not_found'); END IF;
  RETURN jsonb_build_object('success',true,'code','loaded','delivery_id',v_row.delivery_id,
    'channel',v_row.channel,'status',v_row.status,'outbox_id',v_row.id,
    'salon_id',v_row.salon_id,'booking_id',v_row.booking_id,'request_id',v_row.request_id,
    'event',v_row.event_type,'occurrence_version',v_row.occurrence_version,
    'actor_user_id',v_row.actor_user_id,'actor_role',v_row.actor_role,
    'material',v_row.material_snapshot,'material_fingerprint',v_row.material_fingerprint,
    'send_after',v_row.send_after,'expires_at',v_row.expires_at);
END;$load$;

CREATE FUNCTION public.materialize_staff_action_notification_delivery(
  p_delivery_id uuid,p_payload_fingerprint text,p_recipient_fingerprint text,p_dispatch_envelope text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $materialize$
DECLARE v_delivery public.staff_action_notification_deliveries%ROWTYPE;
  v_outbox public.staff_action_notification_outbox%ROWTYPE; v_envelope jsonb;
  v_expected_payload text; v_recipient text; v_expected_recipient text;
  v_keys integer; v_now timestamptz:=transaction_timestamp();
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_delivery_id IS NULL OR coalesce(p_payload_fingerprint,'') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_recipient_fingerprint,'') !~ '^[0-9a-f]{64}$'
     OR p_dispatch_envelope IS NULL OR octet_length(p_dispatch_envelope) NOT BETWEEN 1 AND 262144 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_envelope');
  END IF;
  v_expected_payload:=encode(extensions.digest(convert_to(p_dispatch_envelope,'UTF8'),'sha256'),'hex');
  IF v_expected_payload<>p_payload_fingerprint THEN
    RETURN jsonb_build_object('success',false,'code','payload_fingerprint_mismatch');
  END IF;
  BEGIN v_envelope:=p_dispatch_envelope::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('success',false,'code','invalid_envelope'); END;
  SELECT d.* INTO v_delivery FROM public.staff_action_notification_deliveries d
  WHERE d.id=p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','delivery_not_found'); END IF;
  SELECT o.* INTO STRICT v_outbox FROM public.staff_action_notification_outbox o
  WHERE o.id=v_delivery.outbox_id FOR UPDATE;
  IF v_delivery.status<>'awaiting_material' THEN
    IF v_delivery.payload_fingerprint=p_payload_fingerprint
       AND v_delivery.recipient_fingerprint=p_recipient_fingerprint THEN
      RETURN jsonb_build_object('success',true,'code','already_materialized',
        'delivery_id',v_delivery.id,'status',v_delivery.status);
    END IF;
    RETURN jsonb_build_object('success',false,'code','material_conflict');
  END IF;
  IF v_outbox.status<>'active' OR v_outbox.expires_at<=v_now THEN
    UPDATE public.staff_action_notification_deliveries SET status='cancelled',completed_at=v_now,
      updated_at=v_now,failure_disposition='permanent',error_code='event_inactive'
    WHERE id=v_delivery.id;
    RETURN jsonb_build_object('success',false,'code','event_inactive');
  END IF;
  SELECT count(*) INTO v_keys FROM jsonb_object_keys(v_envelope);
  IF jsonb_typeof(v_envelope)<>'object' OR v_envelope->>'v'<>'1'
     OR v_envelope->>'kind'<>'staff_action' OR v_envelope->>'channel'<>v_delivery.channel
     OR v_envelope->>'salonId'<>v_outbox.salon_id::text
     OR v_envelope->>'bookingId'<>v_outbox.booking_id::text
     OR v_envelope->>'event'<>v_outbox.event_type
     OR v_envelope->>'actorRole'<>v_outbox.actor_role
     OR (v_envelope->>'actorUserId') IS DISTINCT FROM v_outbox.actor_user_id::text THEN
    RETURN jsonb_build_object('success',false,'code','material_mismatch');
  END IF;
  v_recipient:=CASE v_delivery.channel WHEN 'sms' THEN
    nullif(regexp_replace(coalesce(v_outbox.material_snapshot->>'client_phone',''),'\D','','g'),'')
    ELSE nullif(lower(trim(coalesce(v_outbox.material_snapshot->>'client_email',''))),'') END;
  IF v_recipient IS NULL THEN
    UPDATE public.staff_action_notification_deliveries SET status='suppressed',completed_at=v_now,
      updated_at=v_now,failure_disposition='permanent',error_code='recipient_missing'
    WHERE id=v_delivery.id;
    RETURN jsonb_build_object('success',false,'code','recipient_missing');
  END IF;
  IF (v_delivery.channel='sms' AND coalesce((v_outbox.material_snapshot->>'sms_outbound_enabled')::boolean,false) IS NOT TRUE)
     OR (v_delivery.channel='email' AND coalesce((v_outbox.material_snapshot->>'email_outbound_enabled')::boolean,false) IS NOT TRUE) THEN
    UPDATE public.staff_action_notification_deliveries SET status='suppressed',completed_at=v_now,
      updated_at=v_now,failure_disposition='permanent',error_code='channel_disabled'
    WHERE id=v_delivery.id;
    RETURN jsonb_build_object('success',false,'code','channel_disabled');
  END IF;
  IF (CASE v_delivery.channel WHEN 'sms' THEN
      nullif(regexp_replace(coalesce(v_envelope->>'to',''),'\D','','g'),'')
    ELSE nullif(lower(trim(coalesce(v_envelope->>'to',''))),'') END) IS DISTINCT FROM v_recipient THEN
    RETURN jsonb_build_object('success',false,'code','recipient_mismatch');
  END IF;
  v_expected_recipient:=encode(extensions.digest(convert_to(v_recipient,'UTF8'),'sha256'),'hex');
  IF p_recipient_fingerprint<>v_expected_recipient THEN
    RETURN jsonb_build_object('success',false,'code','recipient_fingerprint_mismatch');
  END IF;
  IF (v_delivery.channel='sms' AND (v_keys<>13
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_envelope) k(key)
        WHERE k.key NOT IN ('v','kind','channel','salonId','bookingId','event',
          'actorUserId','actorRole','to','body','statusCallbackUrl','salonIsTest','lang'))
      OR v_envelope->>'lang' NOT IN ('en','vi')
      OR length(coalesce(v_envelope->>'to','')) NOT BETWEEN 1 AND 80
      OR length(coalesce(v_envelope->>'body','')) NOT BETWEEN 1 AND 4000
      OR jsonb_typeof(v_envelope->'statusCallbackUrl')<>'string'
      OR length(v_envelope->>'statusCallbackUrl') NOT BETWEEN 1 AND 2048
      OR v_envelope->>'statusCallbackUrl' !~ '^https://[^[:space:][:cntrl:]]+$'
      OR jsonb_typeof(v_envelope->'salonIsTest')<>'boolean'))
     OR (v_delivery.channel='email' AND (v_keys<>15
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_envelope) k(key)
        WHERE k.key NOT IN ('v','kind','channel','salonId','bookingId','event',
          'actorUserId','actorRole','to','from','subject','html','text','headers','replyTo'))
      OR length(coalesce(v_envelope->>'to','')) NOT BETWEEN 3 AND 320
      OR v_envelope->>'to' !~ '@' OR v_envelope->>'to' ~ '[[:cntrl:]]'
      OR length(coalesce(v_envelope->>'from','')) NOT BETWEEN 1 AND 320
      OR coalesce(v_envelope->>'from','') ~ '[[:cntrl:]]'
      OR length(coalesce(v_envelope->>'subject','')) NOT BETWEEN 1 AND 998
      OR coalesce(v_envelope->>'subject','') ~ '[\r\n]'
      OR length(coalesce(v_envelope->>'html','')) NOT BETWEEN 1 AND 240000
      OR length(coalesce(v_envelope->>'text','')) NOT BETWEEN 1 AND 8000
      OR jsonb_typeof(v_envelope->'headers')<>'object'
      OR (SELECT count(*) FROM jsonb_object_keys(v_envelope->'headers'))>20
      OR EXISTS (SELECT 1 FROM jsonb_each(v_envelope->'headers') h(key,value)
        WHERE h.key !~ '^[A-Za-z0-9-]{1,80}$' OR jsonb_typeof(h.value)<>'string'
          OR length(h.value#>>'{}') NOT BETWEEN 1 AND 2048 OR (h.value#>>'{}') ~ '[\r\n]')
      OR NOT (jsonb_typeof(v_envelope->'replyTo')='null' OR (
        jsonb_typeof(v_envelope->'replyTo')='string'
        AND length(v_envelope->>'replyTo') BETWEEN 3 AND 320
        AND v_envelope->>'replyTo' ~ '@'
        AND v_envelope->>'replyTo' !~ '[[:cntrl:]]')))) THEN
    RETURN jsonb_build_object('success',false,'code','invalid_envelope');
  END IF;
  INSERT INTO public.staff_action_notification_envelopes(
    delivery_id,payload_fingerprint,recipient_fingerprint,dispatch_envelope
  ) VALUES(v_delivery.id,p_payload_fingerprint,p_recipient_fingerprint,p_dispatch_envelope);
  UPDATE public.staff_action_notification_deliveries SET status='pending',
    payload_fingerprint=p_payload_fingerprint,recipient_fingerprint=p_recipient_fingerprint,
    updated_at=v_now WHERE id=v_delivery.id;
  RETURN jsonb_build_object('success',true,'code','materialized','delivery_id',v_delivery.id,
    'status','pending','send_after',v_outbox.send_after);
END;$materialize$;

CREATE FUNCTION public.suppress_unmaterializable_staff_action_delivery(
  p_delivery_id uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $suppress_material$
DECLARE
  v_delivery public.staff_action_notification_deliveries%ROWTYPE;
  v_outbox public.staff_action_notification_outbox%ROWTYPE;
  v_recipient text; v_enabled boolean; v_now timestamptz:=transaction_timestamp();
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_delivery_id IS NULL OR p_reason NOT IN ('recipient_missing','channel_disabled') THEN
    RETURN jsonb_build_object('success',false,'code','invalid_suppression');
  END IF;
  SELECT d.* INTO v_delivery FROM public.staff_action_notification_deliveries d
  WHERE d.id=p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','delivery_not_found'); END IF;
  SELECT o.* INTO STRICT v_outbox FROM public.staff_action_notification_outbox o
  WHERE o.id=v_delivery.outbox_id FOR UPDATE;
  IF v_delivery.status='suppressed' AND v_delivery.error_code=p_reason THEN
    RETURN jsonb_build_object('success',true,'code','already_suppressed',
      'delivery_id',v_delivery.id,'reason',p_reason);
  END IF;
  IF v_delivery.status<>'awaiting_material' OR v_outbox.status<>'active'
     OR v_outbox.material_snapshot IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','suppression_not_available',
      'status',v_delivery.status);
  END IF;
  IF v_delivery.channel='sms' THEN
    v_recipient:=nullif(v_outbox.material_snapshot->>'client_phone','');
    v_enabled:=coalesce((v_outbox.material_snapshot->>'sms_outbound_enabled')::boolean,false);
  ELSE
    v_recipient:=nullif(v_outbox.material_snapshot->>'client_email','');
    v_enabled:=coalesce((v_outbox.material_snapshot->>'email_outbound_enabled')::boolean,false);
  END IF;
  IF (p_reason='recipient_missing' AND v_recipient IS NOT NULL)
     OR (p_reason='channel_disabled' AND v_enabled) THEN
    RETURN jsonb_build_object('success',false,'code','suppression_not_authorized');
  END IF;
  UPDATE public.staff_action_notification_deliveries SET status='suppressed',
    completed_at=v_now,updated_at=v_now,failure_disposition='permanent',
    next_attempt_at=NULL,error_code=p_reason,reconciliation_reason=p_reason
  WHERE id=v_delivery.id;
  RETURN jsonb_build_object('success',true,'code','suppressed',
    'delivery_id',v_delivery.id,'reason',p_reason);
END;$suppress_material$;

CREATE FUNCTION public.lease_due_staff_action_notification_deliveries(p_limit integer)
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $lease$
DECLARE v_limit integer:=least(greatest(coalesce(p_limit,0),0),100);
  v_delivery public.staff_action_notification_deliveries%ROWTYPE;
  v_outbox public.staff_action_notification_outbox%ROWTYPE;
  v_envelope public.staff_action_notification_envelopes%ROWTYPE;
  v_now timestamptz:=transaction_timestamp(); v_token uuid;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() OR v_limit<1 THEN RETURN; END IF;
  FOR v_delivery IN
    SELECT d.* FROM public.staff_action_notification_deliveries d
    JOIN public.staff_action_notification_outbox o ON o.id=d.outbox_id
    WHERE o.status='active' AND o.send_after<=v_now AND o.expires_at>v_now
      AND (d.status='pending' OR (d.status='failed' AND d.failure_disposition='retryable_pre_acceptance'
        AND d.attempt_count<2 AND d.next_attempt_at<=v_now))
    ORDER BY coalesce(d.next_attempt_at,o.send_after),d.created_at,d.id
    FOR UPDATE OF d SKIP LOCKED LIMIT v_limit
  LOOP
    SELECT o.* INTO STRICT v_outbox FROM public.staff_action_notification_outbox o
    WHERE o.id=v_delivery.outbox_id;
    SELECT e.* INTO v_envelope FROM public.staff_action_notification_envelopes e
    WHERE e.delivery_id=v_delivery.id;
    IF NOT FOUND OR v_envelope.payload_fingerprint<>v_delivery.payload_fingerprint
       OR encode(extensions.digest(convert_to(v_envelope.dispatch_envelope,'UTF8'),'sha256'),'hex')
          <>v_delivery.payload_fingerprint THEN
      UPDATE public.staff_action_notification_deliveries SET status='suppressed',completed_at=v_now,
        updated_at=v_now,failure_disposition='permanent',next_attempt_at=NULL,
        error_code='material_changed',reconciliation_reason='material_changed'
      WHERE id=v_delivery.id;
      CONTINUE;
    END IF;
    v_token:=extensions.gen_random_uuid();
    UPDATE public.staff_action_notification_deliveries SET status='sending',
      attempt_count=attempt_count+1,attempt_token=v_token,claimed_at=v_now,completed_at=NULL,
      next_attempt_at=NULL,failure_disposition='none',provider_message_id=NULL,
      error_code=NULL,completion_fingerprint=NULL,reconciliation_reason=NULL,updated_at=v_now
    WHERE id=v_delivery.id RETURNING * INTO v_delivery;
    RETURN NEXT jsonb_build_object('success',true,'code','delivery_claimed','delivery_id',v_delivery.id,
      'event_id',v_delivery.outbox_id,'outbox_id',v_delivery.outbox_id,
      'attempt_token',v_token,'attempt_count',v_delivery.attempt_count,
      'salon_id',v_delivery.salon_id,'booking_id',v_delivery.booking_id,
      'request_id',v_outbox.request_id,'event',v_outbox.event_type,'channel',v_delivery.channel,
      'actor_user_id',v_outbox.actor_user_id,'actor_role',v_outbox.actor_role,
      'payload_fingerprint',v_delivery.payload_fingerprint,
      'envelope_fingerprint',v_delivery.payload_fingerprint,
      'recipient_fingerprint',v_delivery.recipient_fingerprint,
      'dispatch_envelope',v_envelope.dispatch_envelope);
  END LOOP;
END;$lease$;

CREATE FUNCTION public.complete_staff_action_notification_delivery(
  p_delivery_id uuid,p_attempt_token uuid,p_status text,p_provider_message_id text,
  p_error_code text,p_failure_disposition text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $complete$
DECLARE v_delivery public.staff_action_notification_deliveries%ROWTYPE;
  v_outbox public.staff_action_notification_outbox%ROWTYPE;
  v_now timestamptz:=transaction_timestamp(); v_status text:=p_status;
  v_receipt text:=nullif(trim(coalesce(p_provider_message_id,'')),'');
  v_error text; v_disposition text:='none'; v_next timestamptz; v_transition text;
  v_fp text; v_jitter integer;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_delivery_id IS NULL OR p_attempt_token IS NULL
     OR p_status NOT IN ('sent','failed','suppressed','unknown')
     OR length(coalesce(p_provider_message_id,''))>255 OR length(coalesce(p_error_code,''))>80
     OR p_failure_disposition NOT IN ('none','retryable_pre_acceptance','permanent') THEN
    RETURN jsonb_build_object('success',false,'code','invalid_completion');
  END IF;
  SELECT d.* INTO v_delivery FROM public.staff_action_notification_deliveries d
  WHERE d.id=p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','delivery_not_found'); END IF;
  SELECT o.* INTO STRICT v_outbox FROM public.staff_action_notification_outbox o
  WHERE o.id=v_delivery.outbox_id FOR UPDATE;
  IF v_delivery.attempt_token<>p_attempt_token THEN
    RETURN jsonb_build_object('success',false,'code','stale_attempt');
  END IF;
  v_fp:=encode(extensions.digest(convert_to(concat_ws('|',p_status,
    coalesce(trim(p_provider_message_id),''),coalesce(p_error_code,''),p_failure_disposition),'UTF8'),'sha256'),'hex');
  IF v_delivery.status<>'sending' THEN
    IF v_delivery.completion_fingerprint=v_fp THEN
      RETURN jsonb_build_object('success',true,'code','already_completed','status',v_delivery.status,
        'attempt_count',v_delivery.attempt_count);
    END IF;
    RETURN jsonb_build_object('success',false,'code','completion_conflict','status',v_delivery.status);
  END IF;
  IF p_status='sent' THEN
    IF v_receipt IS NULL
      OR (v_delivery.channel='sms' AND v_receipt !~ '^(SM|MM)[0-9A-Fa-f]{32}$')
      OR (v_delivery.channel='email' AND (length(v_receipt)>255 OR v_receipt ~ '[[:cntrl:]]')) THEN
      v_status:='unknown';v_receipt:=NULL;v_error:='invalid_provider_receipt';
    END IF;
  ELSIF p_status='failed' THEN
    v_receipt:=NULL;
    IF (v_delivery.channel='sms' AND p_error_code IN (
         'sms_rate_limited_pre_acceptance','sms_unavailable_pre_acceptance',
         'consent_unavailable_pre_acceptance'))
       OR (v_delivery.channel='email' AND p_error_code IN ('email_rate_limited_pre_acceptance','email_unavailable_pre_acceptance')) THEN
      v_error:=p_error_code;
      IF v_delivery.attempt_count<2 AND v_outbox.expires_at>v_now+interval '5 minutes' THEN
        v_disposition:='retryable_pre_acceptance';
        v_jitter:=(get_byte(extensions.digest(convert_to(v_delivery.id::text||':'||v_delivery.attempt_count,'UTF8'),'sha256'),0))%61;
        v_next:=v_now+interval '5 minutes'+make_interval(secs=>v_jitter);
      ELSE v_disposition:='permanent';v_error:='retry_exhausted'; END IF;
    ELSIF p_error_code IN ('invalid_recipient','consent_revoked','channel_disabled',
      'provider_auth_invalid','provider_configuration_invalid','provider_policy_rejected',
      'invalid_content','unsupported_sender','event_inactive','material_changed') THEN
      v_error:=p_error_code;v_disposition:='permanent';
    ELSE v_status:='unknown';v_error:='unclassified_provider_outcome'; END IF;
  ELSIF p_status='suppressed' THEN
    v_receipt:=NULL;v_disposition:='permanent';
    v_error:=CASE WHEN p_error_code IN ('consent_revoked','channel_disabled','event_inactive','recipient_missing')
      THEN p_error_code ELSE 'suppressed_by_policy' END;
  ELSE v_receipt:=NULL;
    v_error:=CASE WHEN p_error_code IN ('provider_outcome_unknown','transport_timeout',
      'provider_exception','invalid_provider_receipt','completion_write_uncertain')
      THEN p_error_code ELSE 'unclassified_provider_outcome' END;
  END IF;
  UPDATE public.staff_action_notification_deliveries SET status=v_status,
    provider_message_id=v_receipt,error_code=v_error,failure_disposition=v_disposition,
    next_attempt_at=v_next,completed_at=v_now,updated_at=v_now,completion_fingerprint=v_fp,
    reconciliation_reason=CASE WHEN v_status='unknown' THEN v_error ELSE NULL END
  WHERE id=v_delivery.id;
  IF NOT EXISTS (SELECT 1 FROM public.staff_action_notification_deliveries d
    WHERE d.outbox_id=v_outbox.id AND d.status IN ('awaiting_material','pending','sending')
       OR (d.outbox_id=v_outbox.id AND d.status='failed' AND d.failure_disposition='retryable_pre_acceptance')) THEN
    UPDATE public.staff_action_notification_outbox SET status='completed',updated_at=v_now WHERE id=v_outbox.id;
  END IF;
  RETURN jsonb_build_object('success',true,'code','completed','status',v_status,
    'attempt_count',v_delivery.attempt_count,'retry_scheduled',v_next IS NOT NULL,
    'next_attempt_at',v_next,'failure_disposition',v_disposition,
    'caller_disposition_accepted',p_failure_disposition IS NOT DISTINCT FROM v_disposition);
END;$complete$;

CREATE FUNCTION public.reconcile_stale_staff_action_notification_deliveries(p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $reconcile$
DECLARE v_limit integer:=least(greatest(coalesce(p_limit,0),0),1000);
  v_row record; v_now timestamptz:=transaction_timestamp(); v_count integer:=0;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized','reconciled',0);
  END IF;
  FOR v_row IN SELECT d.id,d.outbox_id FROM public.staff_action_notification_deliveries d
    WHERE d.status='sending' AND d.updated_at<v_now-interval '15 minutes'
    ORDER BY d.updated_at,d.id FOR UPDATE SKIP LOCKED LIMIT v_limit
  LOOP
    UPDATE public.staff_action_notification_deliveries SET status='unknown',completed_at=v_now,
      updated_at=v_now,failure_disposition='none',next_attempt_at=NULL,
      error_code='stale_sending_outcome_unknown',reconciliation_reason='stale_sending_outcome_unknown',
      completion_fingerprint=encode(extensions.digest(convert_to(
        'unknown|stale_sending_outcome_unknown','UTF8'),'sha256'),'hex')
    WHERE id=v_row.id;
    IF NOT EXISTS (SELECT 1 FROM public.staff_action_notification_deliveries d
      WHERE d.outbox_id=v_row.outbox_id AND d.status IN ('awaiting_material','pending','sending')
        OR (d.outbox_id=v_row.outbox_id AND d.status='failed' AND d.failure_disposition='retryable_pre_acceptance')) THEN
      UPDATE public.staff_action_notification_outbox SET status='completed',updated_at=v_now WHERE id=v_row.outbox_id;
    END IF;
    v_count:=v_count+1;
  END LOOP;
  WITH expired AS (
    SELECT d.id,d.outbox_id FROM public.staff_action_notification_deliveries d
    JOIN public.staff_action_notification_outbox o ON o.id=d.outbox_id
    WHERE o.expires_at<=v_now AND d.status IN ('awaiting_material','pending')
       OR (o.expires_at<=v_now AND d.status='failed'
         AND d.failure_disposition='retryable_pre_acceptance')
    ORDER BY o.expires_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT v_limit
  ), closed AS (
    UPDATE public.staff_action_notification_deliveries d SET
      status='suppressed',completed_at=v_now,updated_at=v_now,
      failure_disposition='permanent',next_attempt_at=NULL,
      error_code='delivery_window_expired',reconciliation_reason='delivery_window_expired'
    FROM expired x WHERE d.id=x.id RETURNING x.outbox_id
  )
  UPDATE public.staff_action_notification_outbox o SET status='completed',updated_at=v_now
  WHERE o.id IN (SELECT outbox_id FROM closed)
    AND NOT EXISTS (SELECT 1 FROM public.staff_action_notification_deliveries d
      WHERE d.outbox_id=o.id AND d.status IN ('awaiting_material','pending','sending')
        OR (d.outbox_id=o.id AND d.status='failed' AND d.failure_disposition='retryable_pre_acceptance'));
  RETURN jsonb_build_object('success',true,'code','reconciled','reconciled',v_count);
END;$reconcile$;

CREATE FUNCTION public.inspect_staff_action_notification_event(p_salon_id uuid,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path TO '' AS $inspect$
DECLARE v_outbox public.staff_action_notification_outbox%ROWTYPE; v_deliveries jsonb;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  SELECT o.* INTO v_outbox FROM public.staff_action_notification_outbox o
  WHERE o.salon_id=p_salon_id AND o.request_id=p_request_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','event_not_found'); END IF;
  SELECT jsonb_agg(jsonb_build_object('delivery_id',d.id,'channel',d.channel,
    'status',d.status,'attempt_count',d.attempt_count,'error_code',d.error_code,
    'provider_message_id',d.provider_message_id) ORDER BY d.channel) INTO v_deliveries
  FROM public.staff_action_notification_deliveries d WHERE d.outbox_id=v_outbox.id;
  RETURN jsonb_build_object('success',true,'code','loaded','outbox_id',v_outbox.id,
    'salon_id',v_outbox.salon_id,'booking_id',v_outbox.booking_id,'request_id',v_outbox.request_id,
    'event',v_outbox.event_type,'occurrence_version',v_outbox.occurrence_version,
    'actor_user_id',v_outbox.actor_user_id,'actor_role',v_outbox.actor_role,
    'requested_channels',v_outbox.requested_channels,'material_fingerprint',v_outbox.material_fingerprint,
    'notification_delay_seconds',v_outbox.notification_delay_seconds,
    'result',v_outbox.result_snapshot,
    'status',v_outbox.status,'send_after',v_outbox.send_after,'expires_at',v_outbox.expires_at,
    'deliveries',coalesce(v_deliveries,'[]'::jsonb));
END;$inspect$;

CREATE FUNCTION public.cleanup_terminal_staff_action_notification_envelope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $cleanup$
BEGIN
  IF NEW.status IN ('sent','unknown','suppressed','cancelled')
     OR (NEW.status='failed' AND NEW.failure_disposition<>'retryable_pre_acceptance') THEN
    DELETE FROM public.staff_action_notification_envelopes WHERE delivery_id=NEW.id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.staff_action_notification_deliveries d
    WHERE d.outbox_id=NEW.outbox_id AND (
      d.status IN ('awaiting_material','pending','sending')
      OR (d.status='failed' AND d.failure_disposition='retryable_pre_acceptance')
    )
  ) THEN
    UPDATE public.staff_action_notification_outbox SET
      status=CASE WHEN status='cancelled' THEN 'cancelled' ELSE 'completed' END,
      material_snapshot=NULL,updated_at=transaction_timestamp()
    WHERE id=NEW.outbox_id;
  END IF;
  RETURN NEW;
END;$cleanup$;
CREATE TRIGGER cleanup_terminal_staff_action_notification_envelope
AFTER UPDATE OF status,failure_disposition ON public.staff_action_notification_deliveries
FOR EACH ROW EXECUTE FUNCTION public.cleanup_terminal_staff_action_notification_envelope();

CREATE FUNCTION public.prevent_staff_action_notification_envelope_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN RAISE EXCEPTION 'staff action notification envelopes are immutable'
  USING ERRCODE='check_violation'; END $$;
CREATE TRIGGER prevent_staff_action_notification_envelope_update
BEFORE UPDATE ON public.staff_action_notification_envelopes
FOR EACH ROW EXECUTE FUNCTION public.prevent_staff_action_notification_envelope_update();

-- Desk create wrapper. The canonical pricing/create RPC remains the only
-- authority for booking data; this wrapper only supplies transaction-local
-- notification intent and enriches the captured create snapshot after pricing
-- and add-ons have committed inside the same transaction.
CREATE FUNCTION public.create_public_booking_for_desk_with_staff_notification(
  p_salon_id uuid,p_service_id uuid,p_staff_id uuid,p_client_name text,p_client_phone text,
  p_start_time_utc timestamptz,p_end_time_utc timestamptz,p_status text,p_client_notes text,
  p_addon_service_ids uuid[],p_client_email text,p_resource_id uuid,p_combo_id uuid,
  p_voucher_id uuid,p_apply_email_discount boolean,p_idempotency_key uuid,
  p_expected_pricing_fingerprint text,p_actor_user_id uuid,p_notify_email boolean,
  p_notify_sms boolean,p_notification_delay_seconds integer DEFAULT 5
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $desk_create$
DECLARE
  v_actor_role text; v_channels jsonb; v_result jsonb; v_event jsonb;
  v_booking_id uuid; v_material jsonb; v_fp text; v_addons jsonb;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_idempotency_key IS NULL OR p_actor_user_id IS NULL
     OR p_notify_email IS NULL OR p_notify_sms IS NULL
     OR p_notification_delay_seconds NOT BETWEEN 0 AND 120 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_notification_request');
  END IF;
  SELECT m.role INTO v_actor_role FROM public.salon_members m
  WHERE m.salon_id=p_salon_id AND m.user_id=p_actor_user_id
    AND m.role IN ('owner','admin','senior','receptionist') LIMIT 1;
  IF v_actor_role IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','actor_unauthorized');
  END IF;
  v_channels:=jsonb_build_object('sms',p_notify_sms,'email',p_notify_email);
  v_event:=public.inspect_staff_action_notification_event(p_salon_id,p_idempotency_key);
  IF coalesce((v_event->>'success')::boolean,false) THEN
    IF v_event->>'event'<>'create'
       OR (v_event->>'actor_user_id')::uuid IS DISTINCT FROM p_actor_user_id
       OR v_event->'requested_channels' IS DISTINCT FROM v_channels
       OR (v_event->>'notification_delay_seconds')::integer
          IS DISTINCT FROM p_notification_delay_seconds THEN
      RETURN jsonb_build_object('success',false,'code','idempotency_mismatch');
    END IF;
  ELSIF p_notify_email OR p_notify_sms THEN
    PERFORM set_config('nailiq.staff_action_request_id',p_idempotency_key::text,true);
    PERFORM set_config('nailiq.staff_action_actor_user_id',p_actor_user_id::text,true);
    PERFORM set_config('nailiq.staff_action_actor_role',v_actor_role,true);
    PERFORM set_config('nailiq.staff_action_channels',v_channels::text,true);
    PERFORM set_config('nailiq.staff_action_delay_seconds',p_notification_delay_seconds::text,true);
  END IF;
  v_result:=public.create_public_booking(
    p_salon_id,p_service_id,p_staff_id,p_client_name,p_client_phone,p_start_time_utc,
    p_end_time_utc,p_status,p_client_notes,p_addon_service_ids,p_client_email,p_resource_id,
    p_combo_id,p_voucher_id,p_apply_email_discount,p_idempotency_key,
    p_expected_pricing_fingerprint
  );
  PERFORM set_config('nailiq.staff_action_request_id','',true);
  PERFORM set_config('nailiq.staff_action_actor_user_id','',true);
  PERFORM set_config('nailiq.staff_action_actor_role','',true);
  PERFORM set_config('nailiq.staff_action_channels','',true);
  PERFORM set_config('nailiq.staff_action_delay_seconds','',true);
  IF coalesce((v_result->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_result; END IF;
  v_booking_id:=nullif(v_result->>'booking_id','')::uuid;
  IF p_notify_email OR p_notify_sms THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'service_id',ba.service_id,'name',ba.name,'price_cents',ba.price_cents,
      'duration_minutes',ba.duration_minutes) ORDER BY ba.created_at,ba.id),'[]'::jsonb)
    INTO v_addons FROM public.booking_addons ba WHERE ba.booking_id=v_booking_id;
    SELECT o.material_snapshot||jsonb_build_object(
      'price_cents',b.price_cents,'addon_price_cents',b.addon_price_cents,
      'subtotal_cents',b.subtotal_cents,'tax_amount_cents',b.tax_amount_cents,
      'pricing_snapshot',b.public_booking_pricing_snapshot,'addons',v_addons)
    INTO v_material
    FROM public.staff_action_notification_outbox o
    JOIN public.bookings b ON b.id=o.booking_id AND b.salon_id=o.salon_id
    WHERE o.salon_id=p_salon_id AND o.request_id=p_idempotency_key FOR UPDATE OF o;
    IF NOT FOUND THEN
      IF coalesce((v_result->>'idempotent')::boolean,false) THEN
        RETURN jsonb_build_object('success',false,'code','idempotency_mismatch');
      END IF;
      RAISE EXCEPTION 'atomic staff create notification capture failed' USING ERRCODE='NI002';
    END IF;
    v_fp:=encode(extensions.digest(convert_to(v_material::text,'UTF8'),'sha256'),'hex');
    UPDATE public.staff_action_notification_outbox SET material_snapshot=v_material,
      material_fingerprint=v_fp,updated_at=transaction_timestamp()
    WHERE salon_id=p_salon_id AND request_id=p_idempotency_key
      AND material_snapshot IS DISTINCT FROM v_material;
    v_event:=public.inspect_staff_action_notification_event(p_salon_id,p_idempotency_key);
    RETURN v_result||jsonb_build_object('staff_action_notification',v_event);
  END IF;
  IF coalesce((v_event->>'success')::boolean,false) THEN
    RETURN jsonb_build_object('success',false,'code','idempotency_mismatch');
  END IF;
  RETURN v_result;
END;$desk_create$;

-- Deposit-refund cancellation wrapper. Legacy customer-transition email is
-- deliberately disabled; the chosen SMS/email identities belong only to this
-- staff-action outbox.
CREATE FUNCTION public.cancel_booking_with_deposit_refund_saga_for_desk(
  p_salon_id uuid,p_booking_id uuid,p_saga_request_id uuid,
  p_refund_amount_cents integer,p_notify_email boolean,p_notify_sms boolean,
  p_actor_user_id uuid,p_notification_not_before timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $refund_cancel$
DECLARE
  v_actor_role text; v_channels jsonb; v_event jsonb; v_result jsonb;
  v_delay integer:=20;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_saga_request_id IS NULL OR p_actor_user_id IS NULL
     OR p_notify_email IS NULL OR p_notify_sms IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','invalid_notification_request');
  END IF;
  SELECT m.role INTO v_actor_role FROM public.salon_members m
  WHERE m.salon_id=p_salon_id AND m.user_id=p_actor_user_id
    AND m.role IN ('owner','admin','senior','receptionist') LIMIT 1;
  IF v_actor_role IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','actor_unauthorized');
  END IF;
  v_channels:=jsonb_build_object('sms',p_notify_sms,'email',p_notify_email);
  v_event:=public.inspect_staff_action_notification_event(p_salon_id,p_saga_request_id);
  IF coalesce((v_event->>'success')::boolean,false) THEN
    IF v_event->>'booking_id'<>p_booking_id::text OR v_event->>'event'<>'cancel'
       OR (v_event->>'actor_user_id')::uuid IS DISTINCT FROM p_actor_user_id
       OR v_event->'requested_channels' IS DISTINCT FROM v_channels
       OR (v_event->>'notification_delay_seconds')::integer<>v_delay THEN
      RETURN jsonb_build_object('success',false,'code','idempotency_mismatch');
    END IF;
  ELSIF p_notify_email OR p_notify_sms THEN
    PERFORM set_config('nailiq.staff_action_request_id',p_saga_request_id::text,true);
    PERFORM set_config('nailiq.staff_action_actor_user_id',p_actor_user_id::text,true);
    PERFORM set_config('nailiq.staff_action_actor_role',v_actor_role,true);
    PERFORM set_config('nailiq.staff_action_channels',v_channels::text,true);
    PERFORM set_config('nailiq.staff_action_delay_seconds',v_delay::text,true);
  END IF;
  v_result:=public.cancel_booking_with_deposit_refund_saga(
    p_salon_id,p_booking_id,p_saga_request_id,p_refund_amount_cents,false,NULL
  );
  PERFORM set_config('nailiq.staff_action_request_id','',true);
  PERFORM set_config('nailiq.staff_action_actor_user_id','',true);
  PERFORM set_config('nailiq.staff_action_actor_role','',true);
  PERFORM set_config('nailiq.staff_action_channels','',true);
  PERFORM set_config('nailiq.staff_action_delay_seconds','',true);
  IF coalesce((v_result->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_result; END IF;
  -- The legacy transition trigger records even non-requested occurrences as
  -- awaiting activation. This staff wrapper owns the customer delivery, so
  -- remove that never-dispatched duplicate identity in the same transaction.
  DELETE FROM public.customer_booking_transition_email_outbox x
  WHERE x.booking_id=p_booking_id AND x.event_type='cancel'
    AND x.transition_version=nullif(v_result->>'cancellation_transition_version','')::bigint
    AND x.status IN ('awaiting_activation','suppressed');
  IF p_notify_email OR p_notify_sms THEN
    v_event:=public.inspect_staff_action_notification_event(p_salon_id,p_saga_request_id);
    IF coalesce((v_event->>'success')::boolean,false) IS NOT TRUE THEN
      IF coalesce((v_result->>'idempotent')::boolean,false) THEN
        RETURN jsonb_build_object('success',false,'code','idempotency_mismatch');
      END IF;
      RAISE EXCEPTION 'atomic refund cancellation notification capture failed' USING ERRCODE='NI002';
    END IF;
    RETURN v_result||jsonb_build_object('staff_action_notification',v_event);
  END IF;
  IF coalesce((v_event->>'success')::boolean,false) THEN
    RETURN jsonb_build_object('success',false,'code','idempotency_mismatch');
  END IF;
  RETURN v_result;
END;$refund_cancel$;

-- Atomic group cancellation: lock the complete active party, update every
-- member, and attach at most one customer notification to the canonical
-- organizer row. The PII-free action receipt makes both-channel-off replay as
-- exact as a notified cancellation.
CREATE FUNCTION public.cancel_booking_group_for_desk_with_staff_notification(
  p_salon_id uuid,p_group_id uuid,p_request_id uuid,p_actor_user_id uuid,
  p_notify_email boolean,p_notify_sms boolean,p_notification_delay_seconds integer DEFAULT 20
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $group_cancel$
DECLARE
  v_actor_role text; v_channels jsonb; v_receipt public.staff_action_group_cancel_receipts%ROWTYPE;
  v_organizer public.bookings%ROWTYPE; v_active_ids uuid[]; v_ids_json jsonb;
  v_result jsonb; v_fp text; v_event jsonb;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_group_id IS NULL OR p_request_id IS NULL
     OR p_actor_user_id IS NULL OR p_notify_email IS NULL OR p_notify_sms IS NULL
     OR p_notification_delay_seconds NOT BETWEEN 0 AND 120 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_notification_request');
  END IF;
  SELECT m.role INTO v_actor_role FROM public.salon_members m
  WHERE m.salon_id=p_salon_id AND m.user_id=p_actor_user_id
    AND m.role IN ('owner','admin','senior','receptionist') LIMIT 1;
  IF v_actor_role IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','actor_unauthorized');
  END IF;
  v_channels:=jsonb_build_object('sms',p_notify_sms,'email',p_notify_email);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'staff-action-group-cancel:'||p_salon_id::text||':'||p_group_id::text,0));
  SELECT * INTO v_receipt FROM public.staff_action_group_cancel_receipts
  WHERE salon_id=p_salon_id AND request_id=p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_receipt.group_id IS DISTINCT FROM p_group_id
       OR v_receipt.actor_user_id IS DISTINCT FROM p_actor_user_id
       OR v_receipt.requested_channels IS DISTINCT FROM v_channels
       OR v_receipt.notification_delay_seconds IS DISTINCT FROM p_notification_delay_seconds THEN
      RETURN jsonb_build_object('success',false,'code','idempotency_mismatch');
    END IF;
    RETURN v_receipt.result_json||jsonb_build_object('idempotent',true);
  END IF;
  PERFORM 1 FROM public.bookings b WHERE b.salon_id=p_salon_id AND b.group_id=p_group_id
    ORDER BY b.id FOR UPDATE;
  SELECT b.* INTO v_organizer FROM public.bookings b
  WHERE b.salon_id=p_salon_id AND b.group_id=p_group_id
    AND b.is_group_organizer IS TRUE AND b.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','group_not_found'); END IF;
  IF EXISTS (SELECT 1 FROM public.bookings b WHERE b.salon_id=p_salon_id AND b.group_id=p_group_id
    AND b.is_group_organizer IS TRUE AND b.id<>v_organizer.id AND b.deleted_at IS NULL) THEN
    RETURN jsonb_build_object('success',false,'code','group_organizer_ambiguous');
  END IF;
  SELECT array_agg(b.id ORDER BY b.is_group_organizer DESC,b.created_at,b.id)
  INTO v_active_ids FROM public.bookings b
  WHERE b.salon_id=p_salon_id AND b.group_id=p_group_id AND b.deleted_at IS NULL
    AND b.status IN ('pending','confirmed','in_progress');
  IF coalesce(cardinality(v_active_ids),0)<1 OR NOT (v_organizer.id=ANY(v_active_ids)) THEN
    RETURN jsonb_build_object('success',false,'code','group_not_cancellable');
  END IF;
  v_ids_json:=to_jsonb(v_active_ids);
  UPDATE public.bookings SET status='cancelled'
  WHERE salon_id=p_salon_id AND group_id=p_group_id AND id<>v_organizer.id
    AND id=ANY(v_active_ids);
  IF p_notify_email OR p_notify_sms THEN
    PERFORM set_config('nailiq.staff_action_affected_booking_ids',v_ids_json::text,true);
    UPDATE public.bookings SET status='cancelled',
      staff_action_notification_request_id=p_request_id,
      staff_action_notification_actor_user_id=p_actor_user_id,
      staff_action_notification_actor_role=v_actor_role,
      staff_action_notification_channels=v_channels,
      staff_action_notification_delay_seconds=p_notification_delay_seconds
    WHERE id=v_organizer.id AND salon_id=p_salon_id AND status IN ('pending','confirmed','in_progress');
    IF NOT FOUND THEN RAISE EXCEPTION 'atomic group organizer cancel failed' USING ERRCODE='NI002'; END IF;
  ELSE
    UPDATE public.bookings SET status='cancelled'
    WHERE id=v_organizer.id AND salon_id=p_salon_id AND status IN ('pending','confirmed','in_progress');
    IF NOT FOUND THEN RAISE EXCEPTION 'atomic group organizer cancel failed' USING ERRCODE='NI002'; END IF;
  END IF;
  v_event:=public.inspect_staff_action_notification_event(p_salon_id,p_request_id);
  IF (p_notify_email OR p_notify_sms)
     AND coalesce((v_event->>'success')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'atomic group notification capture failed' USING ERRCODE='NI002';
  END IF;
  DELETE FROM public.customer_booking_transition_email_outbox x
  USING public.bookings b
  WHERE b.id=x.booking_id AND b.salon_id=p_salon_id AND b.group_id=p_group_id
    AND x.event_type='cancel' AND x.status IN ('awaiting_activation','suppressed')
    AND b.id=ANY(v_active_ids);
  v_result:=jsonb_build_object('success',true,'code','group_cancelled','idempotent',false,
    'salon_id',p_salon_id,'group_id',p_group_id,'organizer_booking_id',v_organizer.id,
    'cancelled_booking_ids',v_ids_json,'cancelled_count',cardinality(v_active_ids),
    'requested_channels',v_channels,'notification_delay_seconds',p_notification_delay_seconds,
    'staff_action_notification',CASE WHEN p_notify_email OR p_notify_sms THEN v_event ELSE NULL END,
    'undo_semantic','restoring the organizer cancels any still-dispatchable group notification');
  v_fp:=encode(extensions.digest(convert_to(v_result::text,'UTF8'),'sha256'),'hex');
  INSERT INTO public.staff_action_group_cancel_receipts(
    salon_id,group_id,request_id,organizer_booking_id,actor_user_id,actor_role,
    requested_channels,notification_delay_seconds,cancelled_booking_ids,result_json,result_fingerprint
  ) VALUES(p_salon_id,p_group_id,p_request_id,v_organizer.id,p_actor_user_id,v_actor_role,
    v_channels,p_notification_delay_seconds,v_ids_json,v_result,v_fp);
  RETURN v_result;
END;$group_cancel$;

-- Preserve the exact existing desk sequence signature while atomically feeding
-- its already-authoritative request/actor/channel choices to the capture trigger.
ALTER FUNCTION public.reschedule_booking_sequence_for_desk(
  uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text
) RENAME TO reschedule_booking_sequence_for_desk_pre_staff_outbox;
REVOKE ALL ON FUNCTION public.reschedule_booking_sequence_for_desk_pre_staff_outbox(
  uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text
) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.replay_booking_sequence_reschedule_for_desk(
  uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text
) RENAME TO replay_booking_sequence_reschedule_for_desk_pre_staff_outbox;
REVOKE ALL ON FUNCTION public.replay_booking_sequence_reschedule_for_desk_pre_staff_outbox(
  uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text
) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.replay_booking_sequence_reschedule_for_desk(
  p_salon_id uuid,p_booking_id uuid,p_actor_user_id uuid,
  p_notify_email boolean,p_notify_sms boolean,p_request_id uuid,
  p_new_start_time_utc timestamptz,p_expected_sequence_fingerprint text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $replay_wrapper$
DECLARE v_result jsonb; v_event jsonb; v_channels jsonb;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  v_channels:=jsonb_build_object('sms',coalesce(p_notify_sms,false),
    'email',coalesce(p_notify_email,false));
  v_event:=public.inspect_staff_action_notification_event(p_salon_id,p_request_id);
  IF coalesce((v_event->>'success')::boolean,false) THEN
    IF v_event->>'booking_id'<>p_booking_id::text OR v_event->>'event'<>'reschedule'
       OR (v_event->>'actor_user_id')::uuid IS DISTINCT FROM p_actor_user_id
       OR v_event->'requested_channels' IS DISTINCT FROM v_channels THEN
      RETURN jsonb_build_object('success',false,'code','idempotency_mismatch');
    END IF;
  ELSIF coalesce(p_notify_email,false) OR coalesce(p_notify_sms,false) THEN
    RETURN jsonb_build_object('success',false,'code','replay_not_found');
  END IF;
  v_result:=public.replay_booking_sequence_reschedule_for_desk_pre_staff_outbox(
    p_salon_id,p_booking_id,p_actor_user_id,false,false,p_request_id,
    p_new_start_time_utc,p_expected_sequence_fingerprint
  );
  IF coalesce((v_result->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_result; END IF;
  IF coalesce((v_event->>'success')::boolean,false) THEN
    RETURN v_result||jsonb_build_object(
      'customer_transition_email_requested',coalesce(p_notify_email,false),
      'customer_transition_sms_requested',coalesce(p_notify_sms,false),
      'staff_action_notification',v_event);
  END IF;
  RETURN v_result;
END;$replay_wrapper$;

CREATE FUNCTION public.reschedule_booking_sequence_for_desk(
  p_salon_id uuid,p_booking_id uuid,p_actor_user_id uuid,
  p_notify_email boolean,p_notify_sms boolean,p_request_id uuid,
  p_new_start_time_utc timestamptz,p_expected_sequence_fingerprint text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $wrapper$
DECLARE v_result jsonb; v_actor_role text; v_event jsonb; v_channels jsonb;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  SELECT m.role INTO v_actor_role FROM public.salon_members m
  WHERE m.salon_id=p_salon_id AND m.user_id=p_actor_user_id
    AND m.role IN ('owner','admin','receptionist') LIMIT 1;
  v_channels:=jsonb_build_object('sms',coalesce(p_notify_sms,false),
    'email',coalesce(p_notify_email,false));
  v_event:=public.inspect_staff_action_notification_event(p_salon_id,p_request_id);
  IF coalesce((v_event->>'success')::boolean,false) THEN
    IF v_event->>'booking_id'<>p_booking_id::text OR v_event->>'event'<>'reschedule'
       OR (v_event->>'actor_user_id')::uuid IS DISTINCT FROM p_actor_user_id
       OR v_event->'requested_channels' IS DISTINCT FROM v_channels THEN
      RETURN jsonb_build_object('success',false,'code','idempotency_mismatch');
    END IF;
  ELSIF coalesce(p_notify_sms,false) OR coalesce(p_notify_email,false) THEN
    PERFORM set_config('nailiq.staff_action_request_id',coalesce(p_request_id::text,''),true);
    PERFORM set_config('nailiq.staff_action_actor_user_id',coalesce(p_actor_user_id::text,''),true);
    PERFORM set_config('nailiq.staff_action_actor_role',coalesce(v_actor_role,''),true);
    PERFORM set_config('nailiq.staff_action_channels',v_channels::text,true);
    PERFORM set_config('nailiq.staff_action_delay_seconds','5',true);
  END IF;
  -- The new outbox is the only customer delivery identity for desk sequence
  -- reschedules. Passing false/false suppresses the legacy transition email
  -- while the outer payload remains bound to the requested channel choices.
  v_result:=public.reschedule_booking_sequence_for_desk_pre_staff_outbox(
    p_salon_id,p_booking_id,p_actor_user_id,false,false,p_request_id,
    p_new_start_time_utc,p_expected_sequence_fingerprint);
  PERFORM set_config('nailiq.staff_action_request_id','',true);
  PERFORM set_config('nailiq.staff_action_actor_user_id','',true);
  PERFORM set_config('nailiq.staff_action_actor_role','',true);
  PERFORM set_config('nailiq.staff_action_channels','',true);
  PERFORM set_config('nailiq.staff_action_delay_seconds','',true);
  IF coalesce((v_result->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_result; END IF;
  DELETE FROM public.customer_booking_transition_email_outbox x
  WHERE x.booking_id=p_booking_id AND x.event_type='reschedule'
    AND x.transition_version=nullif(v_result->>'customer_transition_version','')::bigint
    AND x.status IN ('awaiting_activation','suppressed');
  SELECT public.inspect_staff_action_notification_event(p_salon_id,p_request_id) INTO v_event;
  IF coalesce(p_notify_sms,false) OR coalesce(p_notify_email,false) THEN
    IF coalesce((v_event->>'success')::boolean,false) IS NOT TRUE THEN
      IF coalesce((v_result->>'idempotent')::boolean,false) THEN
        RETURN jsonb_build_object('success',false,'code','idempotency_mismatch');
      END IF;
      RAISE EXCEPTION 'atomic sequence notification capture failed' USING ERRCODE='NI002';
    END IF;
    RETURN v_result||jsonb_build_object(
      'customer_transition_email_requested',coalesce(p_notify_email,false),
      'customer_transition_sms_requested',coalesce(p_notify_sms,false),
      'staff_action_notification',v_event);
  END IF;
  IF coalesce((v_event->>'success')::boolean,false) THEN
    RETURN jsonb_build_object('success',false,'code','idempotency_mismatch');
  END IF;
  RETURN v_result;
END;$wrapper$;

REVOKE ALL ON FUNCTION public.staff_action_notification_caller_is_service_role(),
  public.capture_staff_action_notification_occurrence(),
  public.cleanup_terminal_staff_action_notification_envelope(),
  public.prevent_staff_action_notification_envelope_update()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.discover_staff_action_notifications_awaiting_material(integer),
  public.load_staff_action_notification_material(uuid),
  public.materialize_staff_action_notification_delivery(uuid,text,text,text),
  public.suppress_unmaterializable_staff_action_delivery(uuid,text),
  public.lease_due_staff_action_notification_deliveries(integer),
  public.complete_staff_action_notification_delivery(uuid,uuid,text,text,text,text),
  public.reconcile_stale_staff_action_notification_deliveries(integer),
  public.inspect_staff_action_notification_event(uuid,uuid),
  public.create_public_booking_for_desk_with_staff_notification(
    uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,uuid,uuid,uuid,
    boolean,uuid,text,uuid,boolean,boolean,integer),
  public.cancel_booking_with_deposit_refund_saga_for_desk(
    uuid,uuid,uuid,integer,boolean,boolean,uuid,timestamptz),
  public.cancel_booking_group_for_desk_with_staff_notification(
    uuid,uuid,uuid,uuid,boolean,boolean,integer),
  public.replay_booking_sequence_reschedule_for_desk(
    uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text),
  public.reschedule_booking_sequence_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.discover_staff_action_notifications_awaiting_material(integer),
  public.load_staff_action_notification_material(uuid),
  public.materialize_staff_action_notification_delivery(uuid,text,text,text),
  public.suppress_unmaterializable_staff_action_delivery(uuid,text),
  public.lease_due_staff_action_notification_deliveries(integer),
  public.complete_staff_action_notification_delivery(uuid,uuid,text,text,text,text),
  public.reconcile_stale_staff_action_notification_deliveries(integer),
  public.inspect_staff_action_notification_event(uuid,uuid),
  public.create_public_booking_for_desk_with_staff_notification(
    uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,uuid,uuid,uuid,
    boolean,uuid,text,uuid,boolean,boolean,integer),
  public.cancel_booking_with_deposit_refund_saga_for_desk(
    uuid,uuid,uuid,integer,boolean,boolean,uuid,timestamptz),
  public.cancel_booking_group_for_desk_with_staff_notification(
    uuid,uuid,uuid,uuid,boolean,boolean,integer),
  public.replay_booking_sequence_reschedule_for_desk(
    uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text),
  public.reschedule_booking_sequence_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)
  TO service_role;

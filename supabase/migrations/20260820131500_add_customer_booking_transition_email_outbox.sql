-- Durable customer email occurrences for reschedule/cancel transitions.
-- This outbox is deliberately separate from one-shot booking_confirmation.
-- The trigger records authoritative occurrences only; no sender/worker is
-- enabled by this migration, so provider behavior remains default-inert.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS customer_transition_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS customer_transition_kind text,
  ADD COLUMN IF NOT EXISTS customer_transitioned_at timestamptz,
  ADD COLUMN IF NOT EXISTS customer_transition_previous_status text,
  ADD COLUMN IF NOT EXISTS customer_transition_previous_start_time_utc timestamptz,
  ADD COLUMN IF NOT EXISTS customer_transition_email_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_transition_email_not_before timestamptz;

DO $booking_transition_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.bookings'::regclass
      AND conname='bookings_customer_transition_version_check'
  ) THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_customer_transition_version_check
      CHECK (customer_transition_version >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.bookings'::regclass
      AND conname='bookings_customer_transition_kind_check'
  ) THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_customer_transition_kind_check
      CHECK (customer_transition_kind IS NULL OR customer_transition_kind IN (
        'reschedule','cancel','undo_cancel'
      )) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.bookings'::regclass
      AND conname='bookings_customer_transition_email_input_ephemeral_check'
  ) THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_customer_transition_email_input_ephemeral_check
      CHECK (
        customer_transition_email_requested=false
        AND customer_transition_email_not_before IS NULL
      ) NOT VALID;
  END IF;
END;
$booking_transition_checks$;

CREATE TABLE public.customer_booking_transition_email_outbox (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('reschedule','cancel')),
  transition_version bigint NOT NULL CHECK (transition_version > 0),
  occurrence_key text NOT NULL UNIQUE CHECK (occurrence_key ~ '^[0-9a-f]{64}$'),
  previous_status text NOT NULL,
  current_status text NOT NULL,
  previous_start_time_utc timestamptz,
  new_start_time_utc timestamptz,
  transitioned_at timestamptz NOT NULL,
  recipient_email text,
  recipient_fingerprint text CHECK (
    recipient_fingerprint IS NULL OR recipient_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  locale text NOT NULL CHECK (locale IN ('en','vi')),
  client_name text NOT NULL,
  service_id uuid NOT NULL,
  service_name text NOT NULL,
  staff_id uuid,
  staff_name text,
  salon_name text NOT NULL,
  salon_slug text NOT NULL,
  salon_timezone text NOT NULL,
  salon_logo_url text,
  salon_phone text,
  material_fingerprint text NOT NULL CHECK (material_fingerprint ~ '^[0-9a-f]{64}$'),
  payload_fingerprint text CHECK (
    payload_fingerprint IS NULL OR payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  status text NOT NULL DEFAULT 'awaiting_activation' CHECK (
    status IN ('awaiting_activation','pending','sending','sent','failed','unknown','suppressed')
  ),
  available_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
  attempt_token uuid,
  claimed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  next_attempt_at timestamptz,
  expires_at timestamptz NOT NULL,
  failure_disposition text NOT NULL DEFAULT 'none' CHECK (
    failure_disposition IN ('none','retryable_pre_acceptance','permanent')
  ),
  provider_name text NOT NULL DEFAULT 'resend' CHECK (provider_name='resend'),
  provider_message_id text,
  error_code text CHECK (error_code IS NULL OR (
    length(error_code) <= 80 AND error_code !~ '[[:cntrl:]]'
  )),
  completion_fingerprint text CHECK (
    completion_fingerprint IS NULL OR completion_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  reconciliation_reason text CHECK (
    reconciliation_reason IS NULL OR reconciliation_reason IN (
      'recipient_missing','transition_superseded','material_changed',
      'retry_exhausted','retry_window_expired','stale_sending_outcome_unknown'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT customer_booking_transition_email_occurrence_once
    UNIQUE (booking_id,event_type,transition_version,recipient_fingerprint),
  CONSTRAINT customer_booking_transition_email_state_check CHECK (
    (status='awaiting_activation' AND attempt_count=0 AND attempt_token IS NULL
      AND claimed_at IS NULL AND completed_at IS NULL AND payload_fingerprint IS NULL
      AND available_at IS NULL)
    OR (status='pending' AND attempt_count=0 AND attempt_token IS NULL
      AND claimed_at IS NULL AND completed_at IS NULL AND payload_fingerprint IS NULL
      AND available_at IS NOT NULL)
    OR (status='sending' AND attempt_count BETWEEN 1 AND 2 AND attempt_token IS NOT NULL
      AND claimed_at IS NOT NULL AND completed_at IS NULL AND payload_fingerprint IS NOT NULL)
    OR (status IN ('sent','failed','unknown','suppressed') AND completed_at IS NOT NULL)
  ),
  CONSTRAINT customer_booking_transition_email_retry_check CHECK (
    next_attempt_at IS NULL OR (
      status='failed' AND failure_disposition='retryable_pre_acceptance'
      AND attempt_count < 2 AND next_attempt_at < expires_at
    )
  ),
  CONSTRAINT customer_booking_transition_email_sent_receipt_check CHECK (
    status <> 'sent' OR (
      nullif(trim(coalesce(provider_message_id,'')),'') IS NOT NULL
      AND length(provider_message_id) <= 255
      AND provider_message_id !~ '[[:cntrl:]]'
    )
  )
);

CREATE INDEX idx_customer_booking_transition_email_due
  ON public.customer_booking_transition_email_outbox(
    coalesce(next_attempt_at,available_at),created_at,id
  ) WHERE (
    status='pending'
    OR (status='failed' AND failure_disposition='retryable_pre_acceptance'
      AND attempt_count < 2)
  );
CREATE INDEX idx_customer_booking_transition_email_salon_time
  ON public.customer_booking_transition_email_outbox(salon_id,created_at DESC);

CREATE TABLE public.customer_booking_transition_email_events (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES public.customer_booking_transition_email_outbox(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('reschedule','cancel')),
  transition_version bigint NOT NULL CHECK (transition_version > 0),
  attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 0 AND 2),
  transition text NOT NULL CHECK (transition IN (
    'occurrence_recorded','activated','claimed_initial','retry_scheduled','retry_leased',
    'sent','suppressed','unknown','permanent_failure','retry_exhausted',
    'stale_sending_unknown','material_conflict'
  )),
  error_code text CHECK (error_code IS NULL OR (
    length(error_code) <= 80 AND error_code !~ '[[:cntrl:]]'
  )),
  receipt_present boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT customer_booking_transition_email_events_once
    UNIQUE(outbox_id,attempt_count,transition)
);
CREATE INDEX idx_customer_booking_transition_email_events_salon_time
  ON public.customer_booking_transition_email_events(salon_id,occurred_at DESC);

ALTER TABLE public.customer_booking_transition_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_booking_transition_email_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.customer_booking_transition_email_outbox
  FROM PUBLIC,anon,authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.customer_booking_transition_email_events
  FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.customer_booking_transition_email_outbox TO service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.customer_booking_transition_email_events TO service_role;

CREATE POLICY "deny direct api access to customer transition email outbox"
  ON public.customer_booking_transition_email_outbox AS RESTRICTIVE
  FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY "deny direct api access to customer transition email events"
  ON public.customer_booking_transition_email_events AS RESTRICTIVE
  FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

CREATE OR REPLACE FUNCTION public.track_customer_booking_transition_email_occurrence()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $trigger$
DECLARE
  v_kind text;
  v_now timestamptz := clock_timestamp();
  v_salon public.salons%ROWTYPE;
  v_service_name text;
  v_staff_name text;
  v_email text;
  v_recipient_fingerprint text;
  v_locale text;
  v_material jsonb;
  v_material_fingerprint text;
  v_occurrence_key text;
  v_outbox public.customer_booking_transition_email_outbox%ROWTYPE;
  v_email_requested boolean;
  v_email_not_before timestamptz;
BEGIN
  -- These two transient inputs let service-role mutations persist the email
  -- choice atomically with the transition. They are always cleared before the
  -- row is stored, so a later unrelated update cannot inherit an old request.
  v_email_requested := current_setting('role',true)='service_role'
    AND coalesce(NEW.customer_transition_email_requested,false);
  v_email_not_before := CASE WHEN v_email_requested
    THEN greatest(v_now,coalesce(NEW.customer_transition_email_not_before,v_now))
    ELSE NULL END;
  NEW.customer_transition_email_requested := false;
  NEW.customer_transition_email_not_before := NULL;

  -- These columns are source-owned. A caller cannot forge or rewind them.
  NEW.customer_transition_version := OLD.customer_transition_version;
  NEW.customer_transition_kind := OLD.customer_transition_kind;
  NEW.customer_transitioned_at := OLD.customer_transitioned_at;
  NEW.customer_transition_previous_status := OLD.customer_transition_previous_status;
  NEW.customer_transition_previous_start_time_utc := OLD.customer_transition_previous_start_time_utc;

  IF NEW.status='cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    v_kind := 'cancel';
  ELSIF OLD.status='cancelled' AND NEW.status IS DISTINCT FROM 'cancelled' THEN
    v_kind := 'undo_cancel';
  ELSIF NEW.start_time_utc IS DISTINCT FROM OLD.start_time_utc THEN
    v_kind := 'reschedule';
  ELSE
    RETURN NEW;
  END IF;

  NEW.customer_transition_version := OLD.customer_transition_version + 1;
  NEW.customer_transition_kind := v_kind;
  NEW.customer_transitioned_at := v_now;
  NEW.customer_transition_previous_status := OLD.status;
  NEW.customer_transition_previous_start_time_utc := OLD.start_time_utc;

  -- Undo is authoritative version history but intentionally has no customer
  -- email occurrence. A later cancel receives a new, distinct version.
  IF v_kind='undo_cancel' THEN RETURN NEW; END IF;

  SELECT s.* INTO STRICT v_salon FROM public.salons s WHERE s.id=NEW.salon_id;
  SELECT sv.name INTO STRICT v_service_name FROM public.services sv
    WHERE sv.id=NEW.service_id AND sv.salon_id=NEW.salon_id;
  IF NEW.staff_id IS NOT NULL THEN
    SELECT st.name INTO v_staff_name FROM public.staff st
      WHERE st.id=NEW.staff_id AND st.salon_id=NEW.salon_id;
  END IF;
  v_email := nullif(lower(trim(coalesce(NEW.client_email,''))), '');
  v_recipient_fingerprint := CASE WHEN v_email IS NULL THEN NULL ELSE encode(
    extensions.digest(pg_catalog.convert_to(v_email,'UTF8'),'sha256'),'hex'
  ) END;
  v_locale := CASE lower(trim(split_part(coalesce(
    nullif(NEW.client_locale,''),nullif(v_salon.default_notification_locale,''),
    nullif(v_salon.default_language,''),'en'
  ),'-',1))) WHEN 'vi' THEN 'vi' ELSE 'en' END;

  v_material := jsonb_build_object(
    'booking_id',NEW.id,'salon_id',NEW.salon_id,'event_type',v_kind,
    'transition_version',NEW.customer_transition_version,
    'previous_status',OLD.status,'current_status',NEW.status,
    'previous_start_epoch',extract(epoch FROM OLD.start_time_utc),
    'new_start_epoch',extract(epoch FROM NEW.start_time_utc),
    'transitioned_epoch',extract(epoch FROM v_now),
    'recipient_fingerprint',v_recipient_fingerprint,'locale',v_locale,
    'client_name',NEW.client_name,'service_id',NEW.service_id,
    'service_name',v_service_name,'staff_id',NEW.staff_id,'staff_name',v_staff_name,
    'salon_name',v_salon.name,'salon_slug',v_salon.slug,
    'salon_timezone',v_salon.timezone,'salon_logo_url',v_salon.logo_url,
    'salon_phone',coalesce(nullif(v_salon.salon_phone,''),v_salon.phone)
  );
  v_material_fingerprint := encode(extensions.digest(
    pg_catalog.convert_to(v_material::text,'UTF8'),'sha256'),'hex');
  v_occurrence_key := encode(extensions.digest(pg_catalog.convert_to(
    concat_ws('|',NEW.id::text,v_kind,NEW.customer_transition_version::text,
      coalesce(extract(epoch FROM OLD.start_time_utc)::text,''),
      coalesce(extract(epoch FROM NEW.start_time_utc)::text,''),
      extract(epoch FROM v_now)::text,coalesce(v_recipient_fingerprint,'')),
    'UTF8'),'sha256'),'hex');

  INSERT INTO public.customer_booking_transition_email_outbox(
    salon_id,booking_id,event_type,transition_version,occurrence_key,
    previous_status,current_status,previous_start_time_utc,new_start_time_utc,
    transitioned_at,recipient_email,recipient_fingerprint,locale,client_name,
    service_id,service_name,staff_id,staff_name,salon_name,salon_slug,
    salon_timezone,salon_logo_url,salon_phone,material_fingerprint,status,available_at,
    completed_at,expires_at,failure_disposition,error_code,reconciliation_reason
  ) VALUES (
    NEW.salon_id,NEW.id,v_kind,NEW.customer_transition_version,v_occurrence_key,
    OLD.status,NEW.status,OLD.start_time_utc,NEW.start_time_utc,v_now,
    v_email,v_recipient_fingerprint,v_locale,NEW.client_name,NEW.service_id,
    v_service_name,NEW.staff_id,v_staff_name,v_salon.name,v_salon.slug,
    v_salon.timezone,v_salon.logo_url,coalesce(nullif(v_salon.salon_phone,''),v_salon.phone),
    v_material_fingerprint,CASE
      WHEN v_email IS NULL THEN 'suppressed'
      WHEN v_email_requested THEN 'pending'
      ELSE 'awaiting_activation' END,
    CASE WHEN v_email IS NOT NULL AND v_email_requested THEN v_email_not_before END,
    CASE WHEN v_email IS NULL THEN v_now ELSE NULL END,
    v_now+interval '30 minutes',
    CASE WHEN v_email IS NULL THEN 'permanent' ELSE 'none' END,
    CASE WHEN v_email IS NULL THEN 'recipient_missing' ELSE NULL END,
    CASE WHEN v_email IS NULL THEN 'recipient_missing' ELSE NULL END
  ) RETURNING * INTO v_outbox;

  INSERT INTO public.customer_booking_transition_email_events(
    outbox_id,booking_id,salon_id,event_type,transition_version,attempt_count,
    transition,error_code
  ) VALUES (v_outbox.id,NEW.id,NEW.salon_id,v_kind,NEW.customer_transition_version,
    0,CASE WHEN v_email IS NULL THEN 'suppressed' ELSE 'occurrence_recorded' END,
    CASE WHEN v_email IS NULL THEN 'recipient_missing' ELSE NULL END);
  RETURN NEW;
END;
$trigger$;

CREATE TRIGGER track_customer_booking_transition_email_occurrence
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.track_customer_booking_transition_email_occurrence();

REVOKE ALL ON FUNCTION public.track_customer_booking_transition_email_occurrence()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.track_customer_booking_transition_email_occurrence()
  TO service_role;

CREATE OR REPLACE FUNCTION public.load_customer_booking_transition_email_material(
  p_salon_id uuid,p_booking_id uuid,p_transition_kind text,
  p_expected_transition_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $load$
DECLARE v_row public.customer_booking_transition_email_outbox%ROWTYPE;
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL
     OR p_transition_kind NOT IN ('reschedule','cancel')
     OR coalesce(p_expected_transition_version,0) < 1 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_request');
  END IF;
  SELECT o.* INTO v_row FROM public.customer_booking_transition_email_outbox o
  WHERE o.salon_id=p_salon_id AND o.booking_id=p_booking_id
    AND o.event_type=p_transition_kind
    AND o.transition_version=p_expected_transition_version;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','transition_not_found'); END IF;
  RETURN jsonb_build_object(
    'success',true,'code','material_loaded','outbox_id',v_row.id,
    'booking_id',v_row.booking_id,'salon_id',v_row.salon_id,
    'event_type',v_row.event_type,'transition_version',v_row.transition_version,
    'occurrence_key',v_row.occurrence_key,'status',v_row.status,
    'available_at',v_row.available_at,
    'recipient_fingerprint',v_row.recipient_fingerprint,
    'material_fingerprint',v_row.material_fingerprint,
    'payload_fingerprint',v_row.payload_fingerprint,
    'snapshot',jsonb_build_object(
      'recipient_email',v_row.recipient_email,'locale',v_row.locale,
      'client_name',v_row.client_name,'service_id',v_row.service_id,
      'service_name',v_row.service_name,'staff_id',v_row.staff_id,
      'staff_name',v_row.staff_name,'salon_name',v_row.salon_name,
      'salon_slug',v_row.salon_slug,'salon_timezone',v_row.salon_timezone,
      'salon_logo_url',v_row.salon_logo_url,'salon_phone',v_row.salon_phone,
      'previous_status',v_row.previous_status,'current_status',v_row.current_status,
      'previous_start_time_utc',v_row.previous_start_time_utc,
      'new_start_time_utc',v_row.new_start_time_utc,
      'transitioned_at',v_row.transitioned_at
    )
  );
END;
$load$;

CREATE OR REPLACE FUNCTION public.activate_customer_booking_transition_email(
  p_salon_id uuid,p_booking_id uuid,p_transition_kind text,
  p_expected_transition_version bigint,p_not_before timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $activate$
DECLARE
  v_row public.customer_booking_transition_email_outbox%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_now timestamptz := transaction_timestamp();
  v_available timestamptz;
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL
     OR p_transition_kind NOT IN ('reschedule','cancel')
     OR coalesce(p_expected_transition_version,0)<1 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_activation');
  END IF;
  SELECT o.* INTO v_row FROM public.customer_booking_transition_email_outbox o
  WHERE o.salon_id=p_salon_id AND o.booking_id=p_booking_id
    AND o.event_type=p_transition_kind
    AND o.transition_version=p_expected_transition_version
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'code','transition_not_found');
  END IF;
  SELECT b.* INTO v_booking FROM public.bookings b
  WHERE b.id=p_booking_id AND b.salon_id=p_salon_id FOR SHARE;
  IF NOT FOUND OR v_booking.customer_transition_version<>v_row.transition_version
     OR v_booking.customer_transition_kind<>v_row.event_type THEN
    IF v_row.status IN ('awaiting_activation','pending','failed') THEN
      UPDATE public.customer_booking_transition_email_outbox SET
        status='suppressed',completed_at=v_now,updated_at=v_now,
        available_at=NULL,next_attempt_at=NULL,failure_disposition='permanent',
        error_code='transition_superseded',reconciliation_reason='transition_superseded'
      WHERE id=v_row.id;
    END IF;
    RETURN jsonb_build_object('success',true,'code','transition_superseded','activated',false);
  END IF;
  IF v_row.status='suppressed' THEN
    RETURN jsonb_build_object('success',true,'code','suppressed','activated',false,
      'status',v_row.status);
  ELSIF v_row.status<>'awaiting_activation' THEN
    RETURN public.load_customer_booking_transition_email_material(
      p_salon_id,p_booking_id,p_transition_kind,p_expected_transition_version
    ) || jsonb_build_object('code','already_activated','activated',false);
  END IF;
  v_available:=greatest(v_now,coalesce(p_not_before,v_now));
  IF v_available>=v_row.expires_at THEN
    UPDATE public.customer_booking_transition_email_outbox SET
      status='suppressed',completed_at=v_now,updated_at=v_now,
      failure_disposition='permanent',error_code='retry_window_expired',
      reconciliation_reason='retry_window_expired'
    WHERE id=v_row.id;
    RETURN jsonb_build_object('success',true,'code','activation_expired','activated',false);
  END IF;
  UPDATE public.customer_booking_transition_email_outbox SET
    status='pending',available_at=v_available,updated_at=v_now
  WHERE id=v_row.id;
  INSERT INTO public.customer_booking_transition_email_events(
    outbox_id,booking_id,salon_id,event_type,transition_version,attempt_count,transition
  ) VALUES(v_row.id,v_row.booking_id,v_row.salon_id,v_row.event_type,
    v_row.transition_version,0,'activated') ON CONFLICT DO NOTHING;
  RETURN public.load_customer_booking_transition_email_material(
    p_salon_id,p_booking_id,p_transition_kind,p_expected_transition_version
  ) || jsonb_build_object('code','activated','activated',true);
END;
$activate$;

CREATE OR REPLACE FUNCTION public.discover_due_customer_booking_transition_emails(
  p_limit integer
)
RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $discover$
DECLARE
  v_limit integer:=least(greatest(coalesce(p_limit,0),0),100);
  v_row public.customer_booking_transition_email_outbox%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_now timestamptz:=transaction_timestamp();
BEGIN
  IF v_limit<1 THEN RETURN; END IF;
  FOR v_row IN
    SELECT o.* FROM public.customer_booking_transition_email_outbox o
    WHERE o.status='pending' AND o.available_at<=v_now
    ORDER BY o.available_at,o.created_at,o.id
    FOR UPDATE SKIP LOCKED LIMIT v_limit
  LOOP
    SELECT b.* INTO v_booking FROM public.bookings b
    WHERE b.id=v_row.booking_id AND b.salon_id=v_row.salon_id;
    IF NOT FOUND OR v_booking.customer_transition_version<>v_row.transition_version
       OR v_booking.customer_transition_kind<>v_row.event_type THEN
      UPDATE public.customer_booking_transition_email_outbox SET
        status='suppressed',completed_at=v_now,updated_at=v_now,
        available_at=NULL,failure_disposition='permanent',
        error_code='transition_superseded',reconciliation_reason='transition_superseded'
      WHERE id=v_row.id;
      INSERT INTO public.customer_booking_transition_email_events(
        outbox_id,booking_id,salon_id,event_type,transition_version,attempt_count,
        transition,error_code
      ) VALUES(v_row.id,v_row.booking_id,v_row.salon_id,v_row.event_type,
        v_row.transition_version,0,'suppressed','transition_superseded')
      ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;
    RETURN NEXT public.load_customer_booking_transition_email_material(
      v_row.salon_id,v_row.booking_id,v_row.event_type,v_row.transition_version
    );
  END LOOP;
END;
$discover$;

CREATE OR REPLACE FUNCTION public.cancel_booking_as_customer_with_transition_email(
  p_token_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $cancel_wrapper$
DECLARE
  v_result record;
  v_booking public.bookings%ROWTYPE;
  v_activation jsonb;
BEGIN
  SELECT * INTO v_result FROM public.cancel_booking_as_customer(p_token_id) LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','mutation_failed');
  END IF;
  IF NOT coalesce(v_result.ok,false) THEN
    RETURN jsonb_build_object('ok',false,'code',coalesce(v_result.code,'mutation_failed'));
  END IF;
  SELECT b.* INTO STRICT v_booking FROM public.bookings b
  WHERE b.id=v_result.booking_id FOR SHARE;
  v_activation:=public.activate_customer_booking_transition_email(
    v_booking.salon_id,v_booking.id,'cancel',v_booking.customer_transition_version,
    transaction_timestamp()
  );
  RETURN jsonb_build_object(
    'ok',true,'code',v_result.code,'booking_id',v_booking.id,
    'salon_id',v_booking.salon_id,
    'customer_transition_version',v_booking.customer_transition_version,
    'customer_transition_kind',v_booking.customer_transition_kind,
    'transition_email',v_activation
  );
END;
$cancel_wrapper$;

CREATE OR REPLACE FUNCTION public.reschedule_booking_as_customer_with_transition_email(
  p_token_id uuid,p_new_start_utc timestamptz,p_new_end_utc timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $reschedule_wrapper$
DECLARE
  v_result record;
  v_booking public.bookings%ROWTYPE;
  v_activation jsonb;
BEGIN
  SELECT * INTO v_result FROM public.reschedule_booking_as_customer(
    p_token_id,p_new_start_utc,p_new_end_utc
  ) LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','mutation_failed');
  END IF;
  IF NOT coalesce(v_result.ok,false) THEN
    RETURN jsonb_build_object('ok',false,'code',coalesce(v_result.code,'mutation_failed'));
  END IF;
  SELECT b.* INTO STRICT v_booking FROM public.bookings b
  WHERE b.id=v_result.booking_id FOR SHARE;
  v_activation:=public.activate_customer_booking_transition_email(
    v_booking.salon_id,v_booking.id,'reschedule',v_booking.customer_transition_version,
    transaction_timestamp()
  );
  RETURN jsonb_build_object(
    'ok',true,'code',v_result.code,'booking_id',v_booking.id,
    'salon_id',v_booking.salon_id,
    'service_name',v_result.service_name,'staff_name',v_result.staff_name,
    'new_start_utc',v_result.new_start_utc,
    'customer_transition_version',v_booking.customer_transition_version,
    'customer_transition_kind',v_booking.customer_transition_kind,
    'transition_email',v_activation
  );
END;
$reschedule_wrapper$;

CREATE OR REPLACE FUNCTION public.claim_customer_booking_transition_email(
  p_salon_id uuid,p_booking_id uuid,p_transition_kind text,
  p_expected_transition_version bigint,p_payload_fingerprint text,
  p_recipient_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $claim$
DECLARE
  v_row public.customer_booking_transition_email_outbox%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_now timestamptz := transaction_timestamp();
  v_token uuid;
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL
     OR p_transition_kind NOT IN ('reschedule','cancel')
     OR coalesce(p_expected_transition_version,0) < 1
     OR coalesce(p_payload_fingerprint,'') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_recipient_fingerprint,'') !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success',false,'code','invalid_claim');
  END IF;
  SELECT o.* INTO v_row FROM public.customer_booking_transition_email_outbox o
  WHERE o.salon_id=p_salon_id AND o.booking_id=p_booking_id
    AND o.event_type=p_transition_kind
    AND o.transition_version=p_expected_transition_version
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','transition_not_found'); END IF;
  IF v_row.recipient_fingerprint IS DISTINCT FROM p_recipient_fingerprint THEN
    RETURN jsonb_build_object('success',false,'code','recipient_fingerprint_mismatch');
  END IF;
  IF v_row.payload_fingerprint IS NOT NULL
     AND v_row.payload_fingerprint <> p_payload_fingerprint THEN
    RETURN jsonb_build_object('success',false,'code','material_conflict');
  END IF;
  IF v_row.status='awaiting_activation' THEN
    RETURN jsonb_build_object('success',true,'code','not_activated','claimed',false);
  END IF;
  SELECT b.* INTO v_booking FROM public.bookings b
  WHERE b.id=p_booking_id AND b.salon_id=p_salon_id;
  IF NOT FOUND OR v_booking.customer_transition_version <> v_row.transition_version
     OR v_booking.customer_transition_kind <> v_row.event_type THEN
    IF v_row.status IN ('pending','failed') THEN
      UPDATE public.customer_booking_transition_email_outbox SET
        status='suppressed',completed_at=v_now,updated_at=v_now,next_attempt_at=NULL,
        failure_disposition='permanent',error_code='transition_superseded',
        reconciliation_reason='transition_superseded'
      WHERE id=v_row.id;
    END IF;
    RETURN jsonb_build_object('success',true,'code','transition_superseded','claimed',false);
  END IF;
  IF v_row.status='pending' THEN
    IF v_row.available_at>v_now THEN
      RETURN jsonb_build_object('success',true,'code','not_due','claimed',false,
        'available_at',v_row.available_at);
    END IF;
    IF v_row.expires_at<=v_now THEN
      UPDATE public.customer_booking_transition_email_outbox SET
        status='suppressed',completed_at=v_now,updated_at=v_now,available_at=NULL,
        failure_disposition='permanent',error_code='retry_window_expired',
        reconciliation_reason='retry_window_expired'
      WHERE id=v_row.id;
      RETURN jsonb_build_object('success',true,'code','activation_expired','claimed',false);
    END IF;
    v_token := extensions.gen_random_uuid();
    UPDATE public.customer_booking_transition_email_outbox SET
      status='sending',attempt_count=1,attempt_token=v_token,claimed_at=v_now,
      updated_at=v_now,available_at=NULL,payload_fingerprint=p_payload_fingerprint
    WHERE id=v_row.id RETURNING * INTO v_row;
    INSERT INTO public.customer_booking_transition_email_events(
      outbox_id,booking_id,salon_id,event_type,transition_version,attempt_count,transition
    ) VALUES(v_row.id,v_row.booking_id,v_row.salon_id,v_row.event_type,
      v_row.transition_version,1,'claimed_initial') ON CONFLICT DO NOTHING;
    RETURN public.load_customer_booking_transition_email_material(
      p_salon_id,p_booking_id,p_transition_kind,p_expected_transition_version
    ) || jsonb_build_object('code','claimed','claimed',true,
      'attempt_token',v_row.attempt_token,'attempt_count',1);
  END IF;
  IF v_row.status='sending' THEN
    IF v_row.updated_at < v_now-interval '15 minutes' THEN
      UPDATE public.customer_booking_transition_email_outbox SET
        status='unknown',completed_at=v_now,updated_at=v_now,
        failure_disposition='none',next_attempt_at=NULL,
        error_code='stale_sending_outcome_unknown',
        reconciliation_reason='stale_sending_outcome_unknown',
        completion_fingerprint=encode(extensions.digest(convert_to(
          'unknown|stale_sending_outcome_unknown','UTF8'),'sha256'),'hex')
      WHERE id=v_row.id;
      RETURN jsonb_build_object('success',true,'code','ambiguous_no_retry','claimed',false);
    END IF;
    RETURN jsonb_build_object('success',true,'code','in_flight','claimed',false);
  END IF;
  IF v_row.status IN ('sent','suppressed') THEN
    RETURN jsonb_build_object('success',true,'code','duplicate_terminal','claimed',false,'status',v_row.status);
  ELSIF v_row.status='unknown' THEN
    RETURN jsonb_build_object('success',true,'code','ambiguous_no_retry','claimed',false);
  ELSIF v_row.status<>'failed' OR v_row.failure_disposition<>'retryable_pre_acceptance' THEN
    RETURN jsonb_build_object('success',true,'code','duplicate_terminal','claimed',false,'status',v_row.status);
  END IF;
  IF v_row.attempt_count>=2 OR v_row.expires_at<=v_now THEN
    UPDATE public.customer_booking_transition_email_outbox SET
      failure_disposition='permanent',next_attempt_at=NULL,updated_at=v_now,
      error_code=CASE WHEN v_row.attempt_count>=2 THEN 'retry_exhausted' ELSE 'retry_window_expired' END,
      reconciliation_reason=CASE WHEN v_row.attempt_count>=2 THEN 'retry_exhausted' ELSE 'retry_window_expired' END
    WHERE id=v_row.id;
    RETURN jsonb_build_object('success',true,'code','retry_exhausted','claimed',false);
  END IF;
  IF v_row.next_attempt_at>v_now THEN
    RETURN jsonb_build_object('success',true,'code','retry_not_due','claimed',false,
      'next_attempt_at',v_row.next_attempt_at);
  END IF;
  v_token := extensions.gen_random_uuid();
  UPDATE public.customer_booking_transition_email_outbox SET
    status='sending',attempt_count=attempt_count+1,attempt_token=v_token,
    claimed_at=v_now,updated_at=v_now,completed_at=NULL,next_attempt_at=NULL,
    failure_disposition='none',provider_message_id=NULL,error_code=NULL,
    completion_fingerprint=NULL,reconciliation_reason=NULL
  WHERE id=v_row.id RETURNING * INTO v_row;
  INSERT INTO public.customer_booking_transition_email_events(
    outbox_id,booking_id,salon_id,event_type,transition_version,attempt_count,transition
  ) VALUES(v_row.id,v_row.booking_id,v_row.salon_id,v_row.event_type,
    v_row.transition_version,v_row.attempt_count,'retry_leased') ON CONFLICT DO NOTHING;
  RETURN public.load_customer_booking_transition_email_material(
    p_salon_id,p_booking_id,p_transition_kind,p_expected_transition_version
  ) || jsonb_build_object('code','claimed','claimed',true,
    'attempt_token',v_row.attempt_token,'attempt_count',v_row.attempt_count);
END;
$claim$;

CREATE OR REPLACE FUNCTION public.complete_customer_booking_transition_email(
  p_outbox_id uuid,p_attempt_token uuid,p_status text,
  p_provider_message_id text,p_error_code text,p_failure_disposition text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $complete$
DECLARE
  v_row public.customer_booking_transition_email_outbox%ROWTYPE;
  v_now timestamptz := transaction_timestamp();
  v_status text := p_status;
  v_receipt text := nullif(trim(coalesce(p_provider_message_id,'')),'');
  v_error text;
  v_disposition text := 'none';
  v_next timestamptz;
  v_jitter integer;
  v_transition text;
  v_completion_fingerprint text;
BEGIN
  IF p_outbox_id IS NULL OR p_attempt_token IS NULL
     OR p_status NOT IN ('sent','suppressed','failed','unknown')
     OR length(coalesce(p_provider_message_id,''))>255
     OR length(coalesce(p_error_code,''))>80
     OR p_failure_disposition NOT IN ('none','retryable_pre_acceptance','permanent') THEN
    RETURN jsonb_build_object('success',false,'code','invalid_completion');
  END IF;
  SELECT o.* INTO v_row FROM public.customer_booking_transition_email_outbox o
  WHERE o.id=p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','outbox_not_found'); END IF;
  IF v_row.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN jsonb_build_object('success',false,'code','stale_attempt');
  END IF;
  v_completion_fingerprint := encode(extensions.digest(convert_to(
    concat_ws('|',p_status,coalesce(trim(p_provider_message_id),''),
      coalesce(p_error_code,''),p_failure_disposition),'UTF8'),'sha256'),'hex');
  IF v_row.status<>'sending' THEN
    IF v_row.completion_fingerprint=v_completion_fingerprint THEN
      RETURN jsonb_build_object('success',true,'code','already_completed',
        'status',v_row.status,'attempt_count',v_row.attempt_count);
    END IF;
    RETURN jsonb_build_object('success',false,'code','completion_conflict',
      'status',v_row.status,'attempt_count',v_row.attempt_count);
  END IF;

  IF p_status='sent' THEN
    IF v_receipt IS NULL OR length(v_receipt)>255 OR v_receipt ~ '[[:cntrl:]]' THEN
      v_status := 'unknown'; v_receipt := NULL;
      v_error := 'invalid_provider_receipt'; v_transition := 'unknown';
    ELSE v_error := NULL; v_transition := 'sent'; END IF;
  ELSIF p_status='failed' THEN
    v_receipt := NULL;
    IF p_error_code IN ('email_rate_limited_pre_acceptance','email_unavailable_pre_acceptance') THEN
      v_error := p_error_code;
      IF v_row.attempt_count<2 AND v_row.expires_at>v_now THEN
        v_disposition := 'retryable_pre_acceptance';
        v_jitter := (
          get_byte(extensions.digest(convert_to(v_row.id::text||':'||v_row.attempt_count,'UTF8'),'sha256'),0)*256
          + get_byte(extensions.digest(convert_to(v_row.id::text||':'||v_row.attempt_count,'UTF8'),'sha256'),1)
        ) % 61;
        v_next := v_now+interval '5 minutes'+make_interval(secs=>v_jitter);
        IF v_next>=v_row.expires_at THEN
          v_disposition:='permanent'; v_next:=NULL;
          v_error:='retry_window_expired'; v_transition:='retry_exhausted';
        ELSE v_transition:='retry_scheduled'; END IF;
      ELSE
        v_disposition:='permanent';
        v_error:=CASE WHEN v_row.attempt_count>=2 THEN 'retry_exhausted' ELSE 'retry_window_expired' END;
        v_transition:='retry_exhausted';
      END IF;
    ELSIF p_error_code IN (
      'invalid_recipient','provider_auth_invalid','provider_configuration_invalid',
      'provider_policy_rejected','invalid_content','unsupported_sender',
      'email_rejected_pre_acceptance','transition_superseded','material_changed'
    ) THEN
      v_error:=p_error_code; v_disposition:='permanent'; v_transition:='permanent_failure';
    ELSE
      v_status:='unknown'; v_error:='email_delivery_ambiguous'; v_transition:='unknown';
    END IF;
  ELSIF p_status='suppressed' THEN
    v_receipt:=NULL; v_disposition:='permanent';
    v_error:=CASE WHEN p_error_code IN (
      'recipient_missing','transition_superseded','material_changed','channel_disabled'
    ) THEN p_error_code ELSE 'channel_disabled' END;
    v_transition:='suppressed';
  ELSE
    v_receipt:=NULL;
    v_error:=CASE WHEN p_error_code IN (
      'email_delivery_ambiguous','transport_timeout','provider_exception',
      'invalid_provider_receipt','completion_write_uncertain'
    ) THEN p_error_code ELSE 'email_delivery_ambiguous' END;
    v_transition:='unknown';
  END IF;

  UPDATE public.customer_booking_transition_email_outbox SET
    status=v_status,provider_message_id=v_receipt,error_code=v_error,
    failure_disposition=v_disposition,next_attempt_at=v_next,
    completed_at=v_now,updated_at=v_now,completion_fingerprint=v_completion_fingerprint,
    reconciliation_reason=CASE
      WHEN v_error='retry_exhausted' THEN 'retry_exhausted'
      WHEN v_error='retry_window_expired' THEN 'retry_window_expired'
      ELSE NULL END
  WHERE id=v_row.id;
  INSERT INTO public.customer_booking_transition_email_events(
    outbox_id,booking_id,salon_id,event_type,transition_version,attempt_count,
    transition,error_code,receipt_present
  ) VALUES(v_row.id,v_row.booking_id,v_row.salon_id,v_row.event_type,
    v_row.transition_version,v_row.attempt_count,v_transition,v_error,v_receipt IS NOT NULL)
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object(
    'success',true,'code','completed','status',v_status,
    'attempt_count',v_row.attempt_count,
    'retry_scheduled',v_disposition='retryable_pre_acceptance',
    'next_attempt_at',v_next,'failure_disposition',v_disposition,
    'caller_disposition_accepted',p_failure_disposition IS NOT DISTINCT FROM v_disposition
  );
END;
$complete$;

CREATE OR REPLACE FUNCTION public.lease_due_customer_booking_transition_email_retries(
  p_limit integer
)
RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $lease$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit,0),0),100);
  v_row public.customer_booking_transition_email_outbox%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_now timestamptz := transaction_timestamp();
  v_token uuid;
BEGIN
  IF v_limit<1 THEN RETURN; END IF;
  FOR v_row IN
    SELECT o.* FROM public.customer_booking_transition_email_outbox o
    WHERE o.status='failed' AND o.failure_disposition='retryable_pre_acceptance'
      AND o.attempt_count<2 AND o.next_attempt_at<=v_now
    ORDER BY o.next_attempt_at,o.created_at,o.id
    FOR UPDATE SKIP LOCKED LIMIT v_limit
  LOOP
    SELECT b.* INTO v_booking FROM public.bookings b
      WHERE b.id=v_row.booking_id AND b.salon_id=v_row.salon_id;
    IF NOT FOUND OR v_booking.customer_transition_version<>v_row.transition_version
       OR v_booking.customer_transition_kind<>v_row.event_type THEN
      UPDATE public.customer_booking_transition_email_outbox SET
        status='suppressed',failure_disposition='permanent',next_attempt_at=NULL,
        completed_at=v_now,updated_at=v_now,error_code='transition_superseded',
        reconciliation_reason='transition_superseded' WHERE id=v_row.id;
      INSERT INTO public.customer_booking_transition_email_events(
        outbox_id,booking_id,salon_id,event_type,transition_version,attempt_count,
        transition,error_code
      ) VALUES(v_row.id,v_row.booking_id,v_row.salon_id,v_row.event_type,
        v_row.transition_version,v_row.attempt_count,'suppressed','transition_superseded')
      ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;
    IF v_row.expires_at<=v_now THEN
      UPDATE public.customer_booking_transition_email_outbox SET
        failure_disposition='permanent',next_attempt_at=NULL,updated_at=v_now,
        error_code='retry_window_expired',reconciliation_reason='retry_window_expired'
      WHERE id=v_row.id;
      CONTINUE;
    END IF;
    v_token:=extensions.gen_random_uuid();
    UPDATE public.customer_booking_transition_email_outbox SET
      status='sending',attempt_count=attempt_count+1,attempt_token=v_token,
      claimed_at=v_now,updated_at=v_now,completed_at=NULL,next_attempt_at=NULL,
      failure_disposition='none',provider_message_id=NULL,error_code=NULL,
      completion_fingerprint=NULL,reconciliation_reason=NULL
    WHERE id=v_row.id RETURNING * INTO v_row;
    INSERT INTO public.customer_booking_transition_email_events(
      outbox_id,booking_id,salon_id,event_type,transition_version,attempt_count,transition
    ) VALUES(v_row.id,v_row.booking_id,v_row.salon_id,v_row.event_type,
      v_row.transition_version,v_row.attempt_count,'retry_leased') ON CONFLICT DO NOTHING;
    RETURN NEXT public.load_customer_booking_transition_email_material(
      v_row.salon_id,v_row.booking_id,v_row.event_type,v_row.transition_version
    ) || jsonb_build_object('code','leased','attempt_token',v_row.attempt_token,
      'attempt_count',v_row.attempt_count,'booking_id',v_row.booking_id,
      'salon_id',v_row.salon_id);
  END LOOP;
END;
$lease$;

CREATE OR REPLACE FUNCTION public.reconcile_stale_customer_booking_transition_email_claims(
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $reconcile$
DECLARE
  v_limit integer:=least(greatest(coalesce(p_limit,0),0),1000);
  v_row public.customer_booking_transition_email_outbox%ROWTYPE;
  v_now timestamptz:=transaction_timestamp();
  v_count integer:=0;
BEGIN
  IF v_limit<1 THEN RETURN jsonb_build_object('success',true,'reconciled',0); END IF;
  FOR v_row IN
    SELECT o.* FROM public.customer_booking_transition_email_outbox o
    WHERE o.status='sending' AND o.updated_at<v_now-interval '15 minutes'
    ORDER BY o.updated_at,o.id FOR UPDATE SKIP LOCKED LIMIT v_limit
  LOOP
    UPDATE public.customer_booking_transition_email_outbox SET
      status='unknown',completed_at=v_now,updated_at=v_now,
      failure_disposition='none',next_attempt_at=NULL,
      error_code='stale_sending_outcome_unknown',
      reconciliation_reason='stale_sending_outcome_unknown',
      completion_fingerprint=encode(extensions.digest(convert_to(
        'unknown|stale_sending_outcome_unknown','UTF8'),'sha256'),'hex')
    WHERE id=v_row.id;
    INSERT INTO public.customer_booking_transition_email_events(
      outbox_id,booking_id,salon_id,event_type,transition_version,attempt_count,
      transition,error_code
    ) VALUES(v_row.id,v_row.booking_id,v_row.salon_id,v_row.event_type,
      v_row.transition_version,v_row.attempt_count,'stale_sending_unknown',
      'stale_sending_outcome_unknown') ON CONFLICT DO NOTHING;
    v_count:=v_count+1;
  END LOOP;
  RETURN jsonb_build_object('success',true,'reconciled',v_count);
END;
$reconcile$;

REVOKE ALL ON FUNCTION public.load_customer_booking_transition_email_material(uuid,uuid,text,bigint)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.load_customer_booking_transition_email_material(uuid,uuid,text,bigint)
  TO service_role;
REVOKE ALL ON FUNCTION public.activate_customer_booking_transition_email(uuid,uuid,text,bigint,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.activate_customer_booking_transition_email(uuid,uuid,text,bigint,timestamptz)
  TO service_role;
REVOKE ALL ON FUNCTION public.discover_due_customer_booking_transition_emails(integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.discover_due_customer_booking_transition_emails(integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.cancel_booking_as_customer_with_transition_email(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking_as_customer_with_transition_email(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.reschedule_booking_as_customer_with_transition_email(uuid,timestamptz,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_booking_as_customer_with_transition_email(uuid,timestamptz,timestamptz)
  TO service_role;
REVOKE ALL ON FUNCTION public.claim_customer_booking_transition_email(uuid,uuid,text,bigint,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_customer_booking_transition_email(uuid,uuid,text,bigint,text,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.complete_customer_booking_transition_email(uuid,uuid,text,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_customer_booking_transition_email(uuid,uuid,text,text,text,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.lease_due_customer_booking_transition_email_retries(integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lease_due_customer_booking_transition_email_retries(integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_stale_customer_booking_transition_email_claims(integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_customer_booking_transition_email_claims(integer)
  TO service_role;

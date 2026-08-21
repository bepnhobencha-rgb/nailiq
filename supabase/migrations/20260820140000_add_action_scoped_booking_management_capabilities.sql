-- MQA-0099: durable, action-scoped booking management capabilities.
-- Additive/default-off: no existing route, reminder token, or public grant is
-- changed. Provider calls and payment/fee mutations are intentionally absent.

CREATE TABLE public.booking_management_action_state (
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN (
    'status','confirm','reschedule','cancel','card_manage',
    'group_status','group_reschedule','group_cancel'
  )),
  epoch bigint NOT NULL DEFAULT 1 CHECK(epoch>0),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(booking_id,action),
  UNIQUE(salon_id,booking_id,action)
);

CREATE TABLE public.booking_management_group_state (
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  organizer_booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  party_version bigint NOT NULL DEFAULT 1 CHECK(party_version>0),
  member_count integer NOT NULL CHECK(member_count>0),
  member_fingerprint text NOT NULL CHECK(member_fingerprint~'^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(salon_id,group_id),
  UNIQUE(organizer_booking_id)
);

CREATE TABLE public.booking_management_capabilities (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  group_id uuid,
  action text NOT NULL,
  scope_kind text NOT NULL CHECK(scope_kind IN (
    'booking_own','member_own','organizer_own','organizer_whole_party'
  )),
  epoch bigint NOT NULL CHECK(epoch>0),
  booking_version bigint NOT NULL CHECK(booking_version>=0),
  card_state_fingerprint text CHECK(card_state_fingerprint IS NULL OR card_state_fingerprint~'^[0-9a-f]{64}$'),
  party_version bigint CHECK(party_version IS NULL OR party_version>0),
  member_fingerprint text CHECK(member_fingerprint IS NULL OR member_fingerprint~'^[0-9a-f]{64}$'),
  party_state_fingerprint text CHECK(party_state_fingerprint IS NULL OR party_state_fingerprint~'^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  consumed_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text CHECK(revoke_reason IS NULL OR revoke_reason IN (
    'replaced_for_longer_expiry','action_consumed','booking_cancelled',
    'group_cancelled','party_changed','booking_changed','manual_revoke'
  )),
  request_id uuid,
  payload_fingerprint text CHECK(payload_fingerprint IS NULL OR payload_fingerprint~'^[0-9a-f]{64}$'),
  result_json jsonb,
  result_fingerprint text CHECK(result_fingerprint IS NULL OR result_fingerprint~'^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY(salon_id,booking_id,action)
    REFERENCES public.booking_management_action_state(salon_id,booking_id,action)
    ON DELETE CASCADE,
  CONSTRAINT booking_management_capability_group_scope_check CHECK(
    (action LIKE 'group\_%' ESCAPE '\' AND group_id IS NOT NULL
      AND party_version IS NOT NULL AND member_fingerprint IS NOT NULL
      AND party_state_fingerprint IS NOT NULL
      AND scope_kind='organizer_whole_party')
    OR (action NOT LIKE 'group\_%' ESCAPE '\' AND group_id IS NULL
      AND party_version IS NULL AND member_fingerprint IS NULL
      AND party_state_fingerprint IS NULL
      AND scope_kind<>'organizer_whole_party')
  ),
  CONSTRAINT booking_management_capability_card_scope_check CHECK(
    (action='card_manage' AND card_state_fingerprint IS NOT NULL)
    OR (action<>'card_manage' AND card_state_fingerprint IS NULL)
  ),
  CONSTRAINT booking_management_capability_completion_check CHECK(
    (consumed_at IS NULL AND request_id IS NULL AND payload_fingerprint IS NULL
      AND result_json IS NULL AND result_fingerprint IS NULL)
    OR (consumed_at IS NOT NULL AND request_id IS NOT NULL AND payload_fingerprint IS NOT NULL
      AND result_json IS NOT NULL AND result_fingerprint IS NOT NULL)
  )
);

CREATE UNIQUE INDEX booking_management_capabilities_one_active
  ON public.booking_management_capabilities(salon_id,booking_id,action,epoch)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_booking_management_capabilities_expiry
  ON public.booking_management_capabilities(expires_at,id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE public.booking_management_action_receipts (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  capability_id uuid NOT NULL REFERENCES public.booking_management_capabilities(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  group_id uuid,
  action text NOT NULL,
  request_id uuid NOT NULL,
  action_epoch bigint NOT NULL CHECK(action_epoch>0),
  payload_fingerprint text NOT NULL CHECK(payload_fingerprint~'^[0-9a-f]{64}$'),
  result_fingerprint text NOT NULL CHECK(result_fingerprint~'^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(capability_id,request_id)
);
CREATE INDEX idx_booking_management_receipts_salon_time
  ON public.booking_management_action_receipts(salon_id,created_at DESC);

CREATE TABLE public.booking_card_management_operations (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  capability_id uuid NOT NULL REFERENCES public.booking_management_capabilities(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,operation text NOT NULL CHECK(operation='remove_card'),
  card_fingerprint text NOT NULL CHECK(card_fingerprint~'^[0-9a-f]{64}$'),
  provider_material jsonb NOT NULL CHECK(jsonb_typeof(provider_material)='object'),
  status text NOT NULL CHECK(status IN ('sending','succeeded','failed','unknown')),
  attempt_token uuid NOT NULL,
  provider_reference text CHECK(provider_reference IS NULL OR
    (length(provider_reference) BETWEEN 1 AND 255 AND provider_reference~'^[[:graph:]]+$')),
  error_code text CHECK(error_code IS NULL OR
    (length(error_code) BETWEEN 1 AND 100 AND error_code~'^[a-z0-9_]+$')),
  result_json jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(capability_id),UNIQUE(capability_id,request_id),
  CONSTRAINT booking_card_operation_completion_check CHECK(
    (status='sending' AND completed_at IS NULL AND result_json IS NULL
      AND provider_reference IS NULL AND error_code IS NULL)
    OR (status='succeeded' AND completed_at IS NOT NULL AND result_json IS NOT NULL
      AND provider_reference IS NOT NULL)
    OR (status IN ('failed','unknown') AND completed_at IS NOT NULL AND result_json IS NOT NULL
      AND error_code IS NOT NULL))
);
CREATE INDEX idx_booking_card_operations_stale
  ON public.booking_card_management_operations(created_at,id) WHERE status='sending';

ALTER TABLE public.booking_management_action_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_management_group_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_management_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_management_action_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_card_management_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.booking_management_action_state,
  public.booking_management_group_state,public.booking_management_capabilities,
  public.booking_management_action_receipts,public.booking_card_management_operations
  FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.booking_management_action_state,
  public.booking_management_group_state,public.booking_management_capabilities,
  public.booking_management_action_receipts,public.booking_card_management_operations TO service_role;
CREATE POLICY "deny direct api booking management state" ON public.booking_management_action_state
  AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY "deny direct api booking management group state" ON public.booking_management_group_state
  AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY "deny direct api booking management capabilities" ON public.booking_management_capabilities
  AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY "deny direct api booking management receipts" ON public.booking_management_action_receipts
  AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY "deny direct api booking card operations" ON public.booking_card_management_operations
  AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

CREATE OR REPLACE FUNCTION public.booking_management_current_group_material(
  p_salon_id uuid,p_group_id uuid
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $group_material$
  WITH members AS (
    SELECT b.id,b.status,b.attendance_status,b.start_time_utc,b.end_time_utc,b.is_group_organizer,b.created_at,
      b.service_id,b.staff_id,sv.name AS service_name,st.name AS staff_name,
      row_number() OVER(ORDER BY b.is_group_organizer DESC,b.created_at,b.id)-1 AS member_index
    FROM public.bookings b
    JOIN public.services sv ON sv.id=b.service_id AND sv.salon_id=b.salon_id
    LEFT JOIN public.staff st ON st.id=b.staff_id AND st.salon_id=b.salon_id
    WHERE b.salon_id=p_salon_id AND b.group_id=p_group_id
  ), material AS (
    SELECT count(*)::integer AS member_count,
      (array_agg(id ORDER BY created_at,id) FILTER(WHERE is_group_organizer))[1]
        AS organizer_booking_id,
      jsonb_agg(jsonb_build_object(
        'booking_id',id,'member_index',member_index,'status',status,
        'attendance_status',attendance_status,
        'start_time_utc',start_time_utc,'end_time_utc',end_time_utc,
        'service_id',service_id,'service_name',service_name,
        'staff_id',staff_id,'staff_name',staff_name
      ) ORDER BY member_index) AS member_rows,
      jsonb_agg(jsonb_build_object(
        'booking_id',id,'member_index',member_index,
        'is_group_organizer',is_group_organizer
      ) ORDER BY member_index) AS identity_rows
    FROM members
  )
  SELECT CASE WHEN member_count<1 OR organizer_booking_id IS NULL THEN NULL ELSE
    jsonb_build_object('member_count',member_count,'organizer_booking_id',organizer_booking_id,
      'members',member_rows,'member_fingerprint',encode(extensions.digest(
        pg_catalog.convert_to(identity_rows::text,'UTF8'),'sha256'),'hex'),
      'party_state_fingerprint',encode(extensions.digest(
        pg_catalog.convert_to(member_rows::text,'UTF8'),'sha256'),'hex')) END
  FROM material
$group_material$;

CREATE OR REPLACE FUNCTION public.refresh_booking_management_group_state(
  p_salon_id uuid,p_group_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $refresh_group$
DECLARE v_material jsonb; v_state public.booking_management_group_state%ROWTYPE; v_now timestamptz:=transaction_timestamp();
BEGIN
  v_material:=public.booking_management_current_group_material(p_salon_id,p_group_id);
  IF v_material IS NULL THEN RETURN jsonb_build_object('ok',false,'code','group_scope_invalid'); END IF;
  SELECT * INTO v_state FROM public.booking_management_group_state
  WHERE salon_id=p_salon_id AND group_id=p_group_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.booking_management_group_state(
      salon_id,group_id,organizer_booking_id,party_version,member_count,member_fingerprint
    ) VALUES(p_salon_id,p_group_id,(v_material->>'organizer_booking_id')::uuid,1,
      (v_material->>'member_count')::integer,v_material->>'member_fingerprint') RETURNING * INTO v_state;
  ELSIF v_state.organizer_booking_id<>(v_material->>'organizer_booking_id')::uuid
     OR v_state.member_fingerprint<>v_material->>'member_fingerprint' THEN
    UPDATE public.booking_management_group_state SET
      organizer_booking_id=(v_material->>'organizer_booking_id')::uuid,
      party_version=party_version+1,member_count=(v_material->>'member_count')::integer,
      member_fingerprint=v_material->>'member_fingerprint',updated_at=v_now
    WHERE salon_id=p_salon_id AND group_id=p_group_id RETURNING * INTO v_state;
    UPDATE public.booking_management_capabilities SET revoked_at=v_now,
      revoke_reason='party_changed',updated_at=v_now
    WHERE salon_id=p_salon_id AND group_id=p_group_id AND action LIKE 'group\_%' ESCAPE '\'
      AND consumed_at IS NULL AND revoked_at IS NULL;
  END IF;
  RETURN v_material||jsonb_build_object('ok',true,'code','group_valid',
    'party_version',v_state.party_version);
END;
$refresh_group$;

CREATE OR REPLACE FUNCTION public.mint_booking_management_capability(
  p_salon_id uuid,p_booking_id uuid,p_action text,p_min_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $mint$
DECLARE
  v_booking public.bookings%ROWTYPE; v_state public.booking_management_action_state%ROWTYPE;
  v_existing public.booking_management_capabilities%ROWTYPE; v_new public.booking_management_capabilities%ROWTYPE;
  v_now timestamptz:=transaction_timestamp(); v_max timestamptz; v_scope text; v_group jsonb; v_card_fp text;
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL OR p_min_expires_at IS NULL
     OR p_action NOT IN ('status','confirm','reschedule','cancel','card_manage','group_status','group_reschedule','group_cancel') THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_request');
  END IF;
  SELECT * INTO v_booking FROM public.bookings
  WHERE id=p_booking_id AND salon_id=p_salon_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','booking_not_found'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    CASE WHEN v_booking.group_id IS NULL THEN 'booking-management:'||p_booking_id::text
      ELSE 'booking-management-group:'||v_booking.group_id::text END,0));
  INSERT INTO public.booking_management_action_state(salon_id,booking_id,action)
  SELECT b.salon_id,b.id,p_action FROM public.bookings b
  WHERE b.id=p_booking_id AND b.salon_id=p_salon_id ON CONFLICT DO NOTHING;
  SELECT * INTO v_state FROM public.booking_management_action_state
  WHERE salon_id=p_salon_id AND booking_id=p_booking_id AND action=p_action FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','booking_not_found'); END IF;
  SELECT * INTO v_booking FROM public.bookings WHERE id=p_booking_id AND salon_id=p_salon_id FOR SHARE;
  IF p_action IN ('confirm','reschedule','cancel','card_manage') AND v_booking.status='cancelled' THEN
    RETURN jsonb_build_object('ok',false,'code','booking_terminal');
  END IF;
  v_max:=CASE WHEN p_action='card_manage' THEN v_now+interval '30 minutes'
    ELSE least(v_now+interval '400 days',CASE WHEN v_booking.start_time_utc IS NULL
      THEN v_now+interval '45 days'
      ELSE greatest(v_now+interval '5 minutes',v_booking.start_time_utc+interval '2 hours') END) END;
  IF p_min_expires_at<=v_now OR p_min_expires_at>v_max THEN
    RETURN jsonb_build_object('ok',false,'code','expiry_out_of_bounds','max_expires_at',v_max);
  END IF;
  IF p_action LIKE 'group\_%' ESCAPE '\' THEN
    IF v_booking.group_id IS NULL OR NOT v_booking.is_group_organizer OR v_booking.status='cancelled' THEN
      RETURN jsonb_build_object('ok',false,'code','group_scope_invalid');
    END IF;
    v_group:=public.refresh_booking_management_group_state(p_salon_id,v_booking.group_id);
    IF v_group->>'ok'<>'true' OR (v_group->>'organizer_booking_id')::uuid<>p_booking_id THEN
      RETURN jsonb_build_object('ok',false,'code','group_scope_invalid');
    END IF;
    v_scope:='organizer_whole_party';
  ELSE
    v_scope:=CASE WHEN v_booking.group_id IS NULL THEN 'booking_own'
      WHEN v_booking.is_group_organizer THEN 'organizer_own' ELSE 'member_own' END;
  END IF;
  v_card_fp:=CASE WHEN p_action='card_manage' THEN encode(extensions.digest(
    pg_catalog.convert_to(jsonb_build_object('card_id',v_booking.noshow_card_id,
      'customer_id',v_booking.noshow_customer_id,'charge_status',v_booking.noshow_charge_status)::text,
      'UTF8'),'sha256'),'hex') END;
  SELECT * INTO v_existing FROM public.booking_management_capabilities
  WHERE salon_id=p_salon_id AND booking_id=p_booking_id AND action=p_action AND epoch=v_state.epoch
    AND consumed_at IS NULL AND revoked_at IS NULL FOR UPDATE;
  IF FOUND AND v_existing.expires_at>=p_min_expires_at
     AND (p_action NOT IN ('reschedule','cancel')
       OR v_existing.booking_version=v_booking.customer_transition_version)
     AND (p_action<>'card_manage' OR v_existing.card_state_fingerprint=v_card_fp)
     AND (p_action NOT LIKE 'group\_%' ESCAPE '\' OR (
       v_existing.party_version=(v_group->>'party_version')::bigint
       AND v_existing.member_fingerprint=v_group->>'member_fingerprint'
       AND v_existing.party_state_fingerprint=v_group->>'party_state_fingerprint')) THEN
    RETURN jsonb_build_object('ok',true,'code','reused','token_id',v_existing.id,
      'action',p_action,'scope_kind',v_existing.scope_kind,'epoch',v_existing.epoch,
      'expires_at',v_existing.expires_at,'party_version',v_existing.party_version);
  END IF;
  IF FOUND THEN UPDATE public.booking_management_capabilities SET revoked_at=v_now,
    revoke_reason=CASE WHEN p_action LIKE 'group\_%' ESCAPE '\' THEN 'party_changed'
      WHEN v_existing.booking_version<>v_booking.customer_transition_version
        OR (p_action='card_manage' AND v_existing.card_state_fingerprint<>v_card_fp) THEN 'booking_changed'
      ELSE 'replaced_for_longer_expiry' END,
    updated_at=v_now WHERE id=v_existing.id; END IF;
  INSERT INTO public.booking_management_capabilities(
    salon_id,booking_id,group_id,action,scope_kind,epoch,booking_version,card_state_fingerprint,
    party_version,member_fingerprint,party_state_fingerprint,expires_at
  ) VALUES(p_salon_id,p_booking_id,CASE WHEN v_group IS NULL THEN NULL ELSE v_booking.group_id END,
    p_action,v_scope,v_state.epoch,v_booking.customer_transition_version,v_card_fp,
    CASE WHEN v_group IS NULL THEN NULL ELSE (v_group->>'party_version')::bigint END,
    v_group->>'member_fingerprint',v_group->>'party_state_fingerprint',p_min_expires_at) RETURNING * INTO v_new;
  RETURN jsonb_build_object('ok',true,'code','minted','token_id',v_new.id,'action',p_action,
    'scope_kind',v_scope,'epoch',v_new.epoch,'expires_at',v_new.expires_at,
    'party_version',v_new.party_version);
END;
$mint$;

-- Trusted server exchange for the browser-direct individual create path. The
-- browser cannot mint by booking id: the server must present the exact random
-- create idempotency key and accepted pricing fingerprint persisted by the
-- canonical 17-argument create RPC. The short exchange window limits bearer
-- recovery; exact create-response replay plus deterministic mint remains safe.
CREATE OR REPLACE FUNCTION public.exchange_public_booking_card_management_capability(
  p_salon_id uuid,p_booking_id uuid,p_idempotency_key uuid,
  p_pricing_fingerprint text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $exchange$
DECLARE v_booking public.bookings%ROWTYPE; v_now timestamptz:=transaction_timestamp();
  v_expiry timestamptz; v_result jsonb;
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL OR p_idempotency_key IS NULL
     OR coalesce(p_pricing_fingerprint,'')!~'^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_request');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'public-booking-idempotency:'||p_salon_id::text||':'||p_idempotency_key::text,0));
  SELECT * INTO v_booking FROM public.bookings
  WHERE id=p_booking_id AND salon_id=p_salon_id AND idempotency_key=p_idempotency_key
    AND public_booking_pricing_fingerprint=p_pricing_fingerprint
    AND pg_catalog.jsonb_typeof(public_booking_pricing_snapshot)='object'
    AND group_id IS NULL AND recovered_from_booking_id IS NULL AND deleted_at IS NULL
    AND status='confirmed'
  FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','create_binding_invalid'); END IF;
  v_expiry:=least(v_booking.created_at+interval '30 minutes',
    coalesce(v_booking.start_time_utc,v_booking.created_at+interval '30 minutes'));
  IF v_booking.status='cancelled' OR v_expiry<=v_now THEN
    RETURN jsonb_build_object('ok',false,'code','exchange_expired');
  END IF;
  v_result:=public.mint_booking_management_capability(
    p_salon_id,p_booking_id,'card_manage',v_expiry);
  IF coalesce(v_result->>'ok','false')<>'true' THEN RETURN v_result; END IF;
  RETURN v_result||jsonb_build_object('code','exchanged','booking_id',p_booking_id);
END;
$exchange$;

REVOKE ALL ON FUNCTION public.exchange_public_booking_card_management_capability(
  uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.exchange_public_booking_card_management_capability(
  uuid,uuid,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.booking_management_cancel_preview(
  p_salon_id uuid,p_booking_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $preview$
DECLARE v_booking public.bookings%ROWTYPE; v_salon public.salons%ROWTYPE;
  v_now timestamptz:=transaction_timestamp(); v_current boolean; v_locked boolean;
  v_within boolean; v_fee integer; v_has_card boolean;
BEGIN
  SELECT * INTO STRICT v_booking FROM public.bookings
  WHERE id=p_booking_id AND salon_id=p_salon_id;
  SELECT * INTO STRICT v_salon FROM public.salons WHERE id=p_salon_id;
  v_current:=v_booking.start_time_utc IS NOT NULL AND v_booking.start_time_utc>v_now
    AND v_booking.start_time_utc<v_now+make_interval(hours=>CASE
      WHEN coalesce(v_salon.self_cancel_window_hours,0)>0 THEN v_salon.self_cancel_window_hours ELSE 24 END);
  v_locked:=v_booking.self_cancel_fee_locked_at IS NOT NULL;
  v_within:=coalesce(v_booking.start_time_utc>v_now,false) AND (v_current OR v_locked);
  v_fee:=CASE WHEN v_locked AND coalesce(v_booking.self_cancel_fee_locked_cents,0)>0
    THEN v_booking.self_cancel_fee_locked_cents
    WHEN v_salon.self_cancel_fee_percent IS NOT NULL AND coalesce(v_salon.noshow_fee_percent,0)>0
      THEN round(greatest(0,coalesce(v_booking.noshow_fee_cents,0))::numeric
        *greatest(0,v_salon.self_cancel_fee_percent)::numeric/v_salon.noshow_fee_percent::numeric)::integer
    ELSE greatest(0,coalesce(v_booking.noshow_fee_cents,0)) END;
  v_has_card:=v_booking.noshow_card_id IS NOT NULL AND v_booking.noshow_consent_at IS NOT NULL
    AND v_fee>0 AND coalesce(v_booking.noshow_charge_status,'')<>'charged';
  RETURN jsonb_build_object('start_past',coalesce(v_booking.start_time_utc<=v_now,true),
    'current_within_window',v_current,'within_window',v_within,
    'has_chargeable_card',v_has_card,
    'will_charge',coalesce(v_salon.self_cancel_fee_enabled,false) AND v_within AND v_has_card,
    'policy_locked_by_reschedule',v_locked,'fee_cents',v_fee,
    'card_last4',v_booking.noshow_card_last4,'card_brand',v_booking.noshow_card_brand,
    'currency',v_salon.currency_code);
END;
$preview$;

CREATE OR REPLACE FUNCTION public.inspect_booking_management_capability(
  p_token_id uuid,p_expected_action text
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $inspect$
DECLARE
  v_cap public.booking_management_capabilities%ROWTYPE;
  v_state public.booking_management_action_state%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_salon public.salons%ROWTYPE;
  v_group jsonb;
  v_preview jsonb;
  v_current_card_fp text;
BEGIN
  IF p_token_id IS NULL OR p_expected_action NOT IN (
    'status','confirm','reschedule','cancel','card_manage',
    'group_status','group_reschedule','group_cancel'
  ) THEN RETURN jsonb_build_object('ok',false,'code','invalid_request'); END IF;
  SELECT * INTO v_cap FROM public.booking_management_capabilities
  WHERE id=p_token_id AND action=p_expected_action;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','invalid_token'); END IF;
  IF v_cap.revoked_at IS NOT NULL OR v_cap.expires_at<=transaction_timestamp() THEN
    RETURN jsonb_build_object('ok',false,'code','expired_or_revoked');
  END IF;
  IF v_cap.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'code','token_consumed');
  END IF;
  SELECT * INTO v_state FROM public.booking_management_action_state
  WHERE salon_id=v_cap.salon_id AND booking_id=v_cap.booking_id AND action=v_cap.action;
  IF NOT FOUND OR v_state.epoch<>v_cap.epoch THEN
    RETURN jsonb_build_object('ok',false,'code','stale_epoch');
  END IF;
  SELECT * INTO v_booking FROM public.bookings
  WHERE id=v_cap.booking_id AND salon_id=v_cap.salon_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','booking_terminal'); END IF;
  IF v_cap.action IN ('reschedule','cancel')
     AND v_cap.booking_version<>v_booking.customer_transition_version THEN
    RETURN jsonb_build_object('ok',false,'code','stale_booking');
  END IF;
  v_current_card_fp:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'card_id',v_booking.noshow_card_id,'customer_id',v_booking.noshow_customer_id,
    'charge_status',v_booking.noshow_charge_status)::text,'UTF8'),'sha256'),'hex');
  IF v_cap.action='card_manage' AND v_cap.card_state_fingerprint<>v_current_card_fp THEN
    RETURN jsonb_build_object('ok',false,'code','stale_card');
  END IF;
  SELECT * INTO STRICT v_salon FROM public.salons WHERE id=v_cap.salon_id;
  IF v_cap.action LIKE 'group\_%' ESCAPE '\' THEN
    v_group:=public.booking_management_current_group_material(v_cap.salon_id,v_cap.group_id);
    IF v_group IS NULL OR (v_group->>'organizer_booking_id')::uuid<>v_cap.booking_id
       OR v_group->>'member_fingerprint'<>v_cap.member_fingerprint
       OR v_group->>'party_state_fingerprint'<>v_cap.party_state_fingerprint THEN
      RETURN jsonb_build_object('ok',false,'code','stale_party');
    END IF;
  END IF;
  v_preview:=public.booking_management_cancel_preview(v_cap.salon_id,v_cap.booking_id);
  RETURN jsonb_build_object(
    'ok',true,'code','valid','action',v_cap.action,'scope_kind',v_cap.scope_kind,
    'epoch',v_cap.epoch,'expires_at',v_cap.expires_at,'party_version',v_cap.party_version,
    'booking',jsonb_build_object(
      'status',v_booking.status,'attendance_status',v_booking.attendance_status,
      'start_time_utc',v_booking.start_time_utc,
      'end_time_utc',v_booking.end_time_utc,
      'service_name',(SELECT sv.name FROM public.services sv WHERE sv.id=v_booking.service_id AND sv.salon_id=v_booking.salon_id),
      'staff_name',(SELECT st.name FROM public.staff st WHERE st.id=v_booking.staff_id AND st.salon_id=v_booking.salon_id),
      'salon_slug',v_salon.slug,'salon_name',v_salon.name,
      'salon_timezone',v_salon.timezone
    ),
    'context',jsonb_build_object(
      'booking_id',v_booking.id,'salon_id',v_booking.salon_id,
      'service_id',v_booking.service_id,'staff_id',v_booking.staff_id,
      'duration_minutes',extract(epoch FROM(v_booking.end_time_utc-v_booking.start_time_utc))/60,
      'timezone',v_salon.timezone,'current_start_time_utc',v_booking.start_time_utc,
      'current_end_time_utc',v_booking.end_time_utc,'group_id',v_booking.group_id,
      'is_group_organizer',v_booking.is_group_organizer
    ),
    'cancel_preview',v_preview,
    'card_manage',jsonb_build_object('has_card',v_booking.noshow_card_id IS NOT NULL,
      'card_fingerprint',v_current_card_fp,'card_last4',v_booking.noshow_card_last4,
      'card_brand',v_booking.noshow_card_brand,'charge_status',v_booking.noshow_charge_status),
    'group',CASE WHEN v_group IS NULL THEN NULL ELSE v_group||jsonb_build_object('party_version',v_cap.party_version) END
  );
END;
$inspect$;

CREATE OR REPLACE FUNCTION public.booking_management_apply_individual(
  p_token_id uuid,p_request_id uuid,p_expected_action text,
  p_new_start_utc timestamptz DEFAULT NULL,p_new_end_utc timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $apply$
DECLARE
  v_cap public.booking_management_capabilities%ROWTYPE;
  v_state public.booking_management_action_state%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_result jsonb; v_payload jsonb; v_payload_hash text; v_result_hash text;
  v_now timestamptz:=transaction_timestamp(); v_old_start timestamptz; v_old_end timestamptz;
  v_transition bigint; v_activation jsonb; v_promoted_waitlist_id uuid;
  v_cancel_preview jsonb; v_lookup_booking_id uuid; v_lookup_group_id uuid; v_waitlist_cap jsonb;
  v_salon public.salons%ROWTYPE; v_lock_at timestamptz; v_lock_cents integer;
BEGIN
  IF p_token_id IS NULL OR p_request_id IS NULL OR p_expected_action NOT IN ('confirm','reschedule','cancel') THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_request');
  END IF;
  v_payload:=CASE p_expected_action WHEN 'reschedule' THEN jsonb_build_object(
    'action','reschedule','new_start_epoch',extract(epoch FROM p_new_start_utc),
    'new_end_epoch',extract(epoch FROM p_new_end_utc))
    ELSE jsonb_build_object('action',p_expected_action) END;
  v_payload_hash:=encode(extensions.digest(pg_catalog.convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
  SELECT booking_id INTO v_lookup_booking_id FROM public.booking_management_capabilities
  WHERE id=p_token_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','invalid_token'); END IF;
  SELECT group_id INTO v_lookup_group_id FROM public.bookings WHERE id=v_lookup_booking_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    CASE WHEN v_lookup_group_id IS NULL THEN 'booking-management:'||v_lookup_booking_id::text
      ELSE 'booking-management-group:'||v_lookup_group_id::text END,0));
  SELECT * INTO v_cap FROM public.booking_management_capabilities WHERE id=p_token_id FOR UPDATE;
  IF NOT FOUND OR v_cap.action<>p_expected_action THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_token');
  END IF;
  IF v_cap.consumed_at IS NOT NULL THEN
    IF v_cap.request_id=p_request_id AND v_cap.payload_fingerprint=v_payload_hash THEN
      RETURN v_cap.result_json||jsonb_build_object('idempotent',true);
    END IF;
    RETURN jsonb_build_object('ok',false,'code','idempotency_mismatch');
  END IF;
  IF v_cap.revoked_at IS NOT NULL OR v_cap.expires_at<=v_now THEN
    RETURN jsonb_build_object('ok',false,'code','expired_or_revoked');
  END IF;
  SELECT * INTO v_state FROM public.booking_management_action_state
  WHERE salon_id=v_cap.salon_id AND booking_id=v_cap.booking_id AND action=v_cap.action FOR UPDATE;
  IF NOT FOUND OR v_state.epoch<>v_cap.epoch THEN
    RETURN jsonb_build_object('ok',false,'code','stale_epoch');
  END IF;
  SELECT * INTO v_booking FROM public.bookings
  WHERE id=v_cap.booking_id AND salon_id=v_cap.salon_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','booking_state_changed'); END IF;
  IF p_expected_action IN ('reschedule','cancel')
     AND v_booking.customer_transition_version<>v_cap.booking_version THEN
    RETURN jsonb_build_object('ok',false,'code','booking_state_changed');
  END IF;
  v_old_start:=v_booking.start_time_utc; v_old_end:=v_booking.end_time_utc;
  IF p_expected_action='cancel' THEN
    v_cancel_preview:=public.booking_management_cancel_preview(v_booking.salon_id,v_booking.id);
  END IF;
  IF p_expected_action='confirm' THEN
    IF v_booking.status NOT IN ('pending','confirmed') THEN
      RETURN jsonb_build_object('ok',false,'code','booking_state_changed');
    END IF;
    UPDATE public.bookings SET status='confirmed',confirmed_at=coalesce(confirmed_at,v_now),
      attendance_status=CASE WHEN v_cap.scope_kind IN ('member_own','organizer_own')
        THEN 'confirmed' ELSE attendance_status END
    WHERE id=v_booking.id;
  ELSIF p_expected_action='reschedule' THEN
    IF v_booking.status NOT IN ('pending','confirmed') OR v_booking.start_time_utc<=v_now
       OR p_new_start_utc IS NULL
       OR p_new_end_utc IS NULL OR p_new_start_utc<=v_now OR p_new_end_utc<=p_new_start_utc
       OR p_new_end_utc-p_new_start_utc>interval '24 hours' THEN
      RETURN jsonb_build_object('ok',false,'code','invalid_slot');
    END IF;
    IF EXISTS(SELECT 1 FROM public.bookings b WHERE b.id<>v_booking.id
      AND b.salon_id=v_booking.salon_id AND b.staff_id=v_booking.staff_id
      AND b.status<>'cancelled' AND b.deleted_at IS NULL
      AND b.start_time_utc<p_new_end_utc AND b.end_time_utc>p_new_start_utc) THEN
      RETURN jsonb_build_object('ok',false,'code','slot_conflict');
    END IF;
    SELECT * INTO STRICT v_salon FROM public.salons WHERE id=v_booking.salon_id;
    IF v_booking.self_cancel_fee_locked_at IS NULL
       AND coalesce(v_salon.self_cancel_fee_enabled,false)
       AND v_old_start>v_now AND v_old_start<v_now+make_interval(hours=>CASE
         WHEN coalesce(v_salon.self_cancel_window_hours,0)>0 THEN v_salon.self_cancel_window_hours ELSE 24 END) THEN
      v_lock_cents:=CASE WHEN v_salon.self_cancel_fee_percent IS NOT NULL
        AND coalesce(v_salon.noshow_fee_percent,0)>0 THEN round(
          greatest(0,coalesce(v_booking.noshow_fee_cents,0))::numeric
          *greatest(0,v_salon.self_cancel_fee_percent)::numeric/v_salon.noshow_fee_percent::numeric)::integer
        ELSE greatest(0,coalesce(v_booking.noshow_fee_cents,0)) END;
      IF v_lock_cents>0 THEN v_lock_at:=v_now; END IF;
    END IF;
    BEGIN
      UPDATE public.bookings SET rescheduled_from_time_utc=start_time_utc,
        start_time_utc=p_new_start_utc,end_time_utc=p_new_end_utc,rescheduled_at=v_now,
        rescheduled_by='customer',reminder_24h_sent_at=NULL,reminder_3h_sent_at=NULL,
        status='confirmed',customer_transition_email_requested=true,
        customer_transition_email_not_before=v_now,
        self_cancel_fee_locked_at=coalesce(self_cancel_fee_locked_at,v_lock_at),
        self_cancel_fee_locked_cents=coalesce(self_cancel_fee_locked_cents,v_lock_cents),
        self_cancel_fee_lock_reason=coalesce(self_cancel_fee_lock_reason,
          CASE WHEN v_lock_at IS NOT NULL THEN 'customer_reschedule' END)
      WHERE id=v_booking.id RETURNING * INTO v_booking;
    EXCEPTION WHEN exclusion_violation THEN
      RETURN jsonb_build_object('ok',false,'code','slot_conflict');
    END;
    v_transition:=v_booking.customer_transition_version;
    v_cancel_preview:=public.booking_management_cancel_preview(v_booking.salon_id,v_booking.id);
    v_activation:=public.activate_customer_booking_transition_email(
      v_booking.salon_id,v_booking.id,'reschedule',v_transition,v_now);
  ELSE
    IF v_booking.status NOT IN ('pending','confirmed') OR v_booking.start_time_utc<=v_now THEN
      RETURN jsonb_build_object('ok',false,'code','too_late');
    END IF;
    UPDATE public.bookings SET status='cancelled',
      attendance_status=CASE WHEN v_cap.scope_kind IN ('member_own','organizer_own')
        THEN 'declined' ELSE attendance_status END,
      customer_transition_email_requested=true,customer_transition_email_not_before=v_now
    WHERE id=v_booking.id RETURNING customer_transition_version INTO v_transition;
    v_activation:=public.activate_customer_booking_transition_email(
      v_booking.salon_id,v_booking.id,'cancel',v_transition,v_now);
  END IF;
  IF p_expected_action IN ('reschedule','cancel') THEN
    v_waitlist_cap:=public.promote_waitlist_for_freed_slot(
      v_booking.salon_id,v_booking.service_id,
      (v_old_start AT TIME ZONE coalesce(nullif(trim((SELECT s.timezone
        FROM public.salons s WHERE s.id=v_booking.salon_id)),''),'America/Los_Angeles'))::date,
      v_booking.staff_id,v_old_start,v_old_end,20);
    IF v_waitlist_cap->>'code'='promoted' THEN
      v_promoted_waitlist_id:=(v_waitlist_cap->>'waitlist_entry_id')::uuid;
    END IF;
  END IF;
  v_result:=jsonb_build_object('ok',true,'code',CASE p_expected_action
      WHEN 'confirm' THEN 'confirmed' WHEN 'reschedule' THEN 'rescheduled' ELSE 'cancelled' END,
    'action',p_expected_action,'booking_id',v_booking.id,'salon_id',v_booking.salon_id,
    'scope_kind',v_cap.scope_kind,'group_id',v_booking.group_id,
    'rsvp_semantic',CASE WHEN v_cap.scope_kind IN ('member_own','organizer_own') THEN
      CASE WHEN p_expected_action='confirm' THEN 'confirm'
        WHEN p_expected_action='cancel' THEN 'decline' END END,
    'service_id',v_booking.service_id,'staff_id',v_booking.staff_id,
    'service_name',(SELECT sv.name FROM public.services sv WHERE sv.id=v_booking.service_id),
    'staff_name',(SELECT st.name FROM public.staff st WHERE st.id=v_booking.staff_id),
    'salon_slug',(SELECT s.slug FROM public.salons s WHERE s.id=v_booking.salon_id),
    'salon_name',(SELECT s.name FROM public.salons s WHERE s.id=v_booking.salon_id),
    'salon_timezone',(SELECT s.timezone FROM public.salons s WHERE s.id=v_booking.salon_id),
    'previous_start_time_utc',v_old_start,
    'start_time_utc',CASE WHEN p_expected_action='reschedule' THEN p_new_start_utc ELSE v_booking.start_time_utc END,
    'end_time_utc',CASE WHEN p_expected_action='reschedule' THEN p_new_end_utc ELSE v_booking.end_time_utc END,
    'status',CASE WHEN p_expected_action='cancel' THEN 'cancelled' ELSE 'confirmed' END,
    'attendance_status',CASE WHEN v_cap.scope_kind IN ('member_own','organizer_own') THEN
      CASE WHEN p_expected_action='cancel' THEN 'declined'
        WHEN p_expected_action='confirm' THEN 'confirmed' ELSE v_booking.attendance_status END
      ELSE v_booking.attendance_status END,
    'action_epoch',v_cap.epoch,'customer_transition_version',v_transition,
    'transition_email',v_activation,'cancel_preview',v_cancel_preview,
    'promoted_waitlist',CASE WHEN v_promoted_waitlist_id IS NULL THEN NULL ELSE
      jsonb_build_object('waitlist_entry_id',v_promoted_waitlist_id,
        'claim_capability_token',v_waitlist_cap->>'claim_capability_token',
        'offer_epoch',(v_waitlist_cap->>'offer_epoch')::bigint,
        'expires_at',v_waitlist_cap->>'expires_at') END,
    'idempotent',false);
  v_result_hash:=encode(extensions.digest(pg_catalog.convert_to(v_result::text,'UTF8'),'sha256'),'hex');
  UPDATE public.booking_management_capabilities SET consumed_at=v_now,request_id=p_request_id,
    payload_fingerprint=v_payload_hash,result_json=v_result,result_fingerprint=v_result_hash,
    revoke_reason='action_consumed',updated_at=v_now WHERE id=v_cap.id;
  UPDATE public.booking_management_action_state SET epoch=epoch+1,updated_at=v_now
  WHERE salon_id=v_cap.salon_id AND booking_id=v_cap.booking_id AND action=v_cap.action;
  INSERT INTO public.booking_management_action_receipts(capability_id,salon_id,booking_id,
    group_id,action,request_id,action_epoch,payload_fingerprint,result_fingerprint)
  VALUES(v_cap.id,v_cap.salon_id,v_cap.booking_id,NULL,v_cap.action,p_request_id,
    v_cap.epoch,v_payload_hash,v_result_hash);
  IF p_expected_action='cancel' THEN
    UPDATE public.booking_management_capabilities SET revoked_at=v_now,
      revoke_reason='booking_cancelled',updated_at=v_now
    WHERE salon_id=v_cap.salon_id AND booking_id=v_cap.booking_id
      AND action IN ('confirm','reschedule','cancel','card_manage')
      AND id<>v_cap.id AND consumed_at IS NULL AND revoked_at IS NULL;
  END IF;
  RETURN v_result;
END;
$apply$;

CREATE OR REPLACE FUNCTION public.confirm_booking_with_management_capability(
  p_token_id uuid,p_request_id uuid
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO '' AS $$
  SELECT public.booking_management_apply_individual(p_token_id,p_request_id,'confirm',NULL,NULL)
$$;
CREATE OR REPLACE FUNCTION public.reschedule_booking_with_management_capability(
  p_token_id uuid,p_request_id uuid,p_new_start_utc timestamptz,p_new_end_utc timestamptz
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO '' AS $$
  SELECT public.booking_management_apply_individual(p_token_id,p_request_id,'reschedule',p_new_start_utc,p_new_end_utc)
$$;
CREATE OR REPLACE FUNCTION public.cancel_booking_with_management_capability(
  p_token_id uuid,p_request_id uuid
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO '' AS $$
  SELECT public.booking_management_apply_individual(p_token_id,p_request_id,'cancel',NULL,NULL)
$$;

REVOKE ALL ON FUNCTION public.booking_management_current_group_material(uuid,uuid),
  public.refresh_booking_management_group_state(uuid,uuid),
  public.mint_booking_management_capability(uuid,uuid,text,timestamptz),
  public.booking_management_cancel_preview(uuid,uuid),
  public.inspect_booking_management_capability(uuid,text),
  public.booking_management_apply_individual(uuid,uuid,text,timestamptz,timestamptz),
  public.confirm_booking_with_management_capability(uuid,uuid),
  public.reschedule_booking_with_management_capability(uuid,uuid,timestamptz,timestamptz),
  public.cancel_booking_with_management_capability(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mint_booking_management_capability(uuid,uuid,text,timestamptz),
  public.inspect_booking_management_capability(uuid,text),
  public.confirm_booking_with_management_capability(uuid,uuid),
  public.reschedule_booking_with_management_capability(uuid,uuid,timestamptz,timestamptz),
  public.cancel_booking_with_management_capability(uuid,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.booking_management_current_group_material(uuid,uuid),
  public.refresh_booking_management_group_state(uuid,uuid),
  public.booking_management_cancel_preview(uuid,uuid),
  public.booking_management_apply_individual(uuid,uuid,text,timestamptz,timestamptz)
  TO service_role;

COMMENT ON TABLE public.booking_management_capabilities IS
  'MQA-0099 service-only action-scoped bearer capabilities. Additive/default-off until app adoption.';

CREATE OR REPLACE FUNCTION public.booking_management_apply_group(
  p_token_id uuid,p_request_id uuid,p_expected_action text,p_member_slots jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $group_apply$
DECLARE
  v_cap public.booking_management_capabilities%ROWTYPE;
  v_state public.booking_management_action_state%ROWTYPE;
  v_group_state public.booking_management_group_state%ROWTYPE;
  v_material jsonb; v_payload jsonb; v_payload_hash text; v_result_hash text;
  v_result jsonb; v_now timestamptz:=transaction_timestamp();
  v_slot jsonb; v_booking public.bookings%ROWTYPE; v_transition bigint;
  v_transitions jsonb:='[]'::jsonb; v_booking_ids jsonb; v_tz text;
  v_lookup_booking_id uuid; v_lookup_group_id uuid;
BEGIN
  IF p_token_id IS NULL OR p_request_id IS NULL
     OR p_expected_action NOT IN ('group_reschedule','group_cancel') THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_request');
  END IF;
  IF p_expected_action='group_reschedule' THEN
    IF p_member_slots IS NULL OR jsonb_typeof(p_member_slots)<>'array' THEN
      RETURN jsonb_build_object('ok',false,'code','invalid_slot');
    END IF;
    SELECT coalesce(jsonb_agg(e ORDER BY e->>'booking_id'),'[]'::jsonb) INTO v_payload
    FROM jsonb_array_elements(p_member_slots) e;
    v_payload:=jsonb_build_object('action','group_reschedule','member_slots',v_payload);
  ELSE v_payload:=jsonb_build_object('action','group_cancel'); END IF;
  v_payload_hash:=encode(extensions.digest(pg_catalog.convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
  SELECT booking_id,group_id INTO v_lookup_booking_id,v_lookup_group_id FROM public.booking_management_capabilities
  WHERE id=p_token_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','invalid_token'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    CASE WHEN v_lookup_group_id IS NULL THEN 'booking-management:'||v_lookup_booking_id::text
      ELSE 'booking-management-group:'||v_lookup_group_id::text END,0));
  SELECT * INTO v_cap FROM public.booking_management_capabilities WHERE id=p_token_id FOR UPDATE;
  IF NOT FOUND OR v_cap.action<>p_expected_action OR v_cap.scope_kind<>'organizer_whole_party' THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_token');
  END IF;
  IF v_cap.consumed_at IS NOT NULL THEN
    IF v_cap.request_id=p_request_id AND v_cap.payload_fingerprint=v_payload_hash THEN
      RETURN v_cap.result_json||jsonb_build_object('idempotent',true);
    END IF;
    RETURN jsonb_build_object('ok',false,'code','idempotency_mismatch');
  END IF;
  IF v_cap.revoked_at IS NOT NULL OR v_cap.expires_at<=v_now THEN
    RETURN jsonb_build_object('ok',false,'code','expired_or_revoked');
  END IF;
  SELECT * INTO v_state FROM public.booking_management_action_state
  WHERE salon_id=v_cap.salon_id AND booking_id=v_cap.booking_id AND action=v_cap.action FOR UPDATE;
  IF NOT FOUND OR v_state.epoch<>v_cap.epoch THEN
    RETURN jsonb_build_object('ok',false,'code','stale_epoch');
  END IF;
  SELECT * INTO v_group_state FROM public.booking_management_group_state
  WHERE salon_id=v_cap.salon_id AND group_id=v_cap.group_id FOR UPDATE;
  v_material:=public.booking_management_current_group_material(v_cap.salon_id,v_cap.group_id);
  IF NOT FOUND OR v_material IS NULL OR v_group_state.party_version<>v_cap.party_version
     OR v_material->>'member_fingerprint'<>v_cap.member_fingerprint
     OR v_material->>'party_state_fingerprint'<>v_cap.party_state_fingerprint
     OR (v_material->>'organizer_booking_id')::uuid<>v_cap.booking_id THEN
    RETURN jsonb_build_object('ok',false,'code','stale_party');
  END IF;
  PERFORM 1 FROM public.bookings b WHERE b.salon_id=v_cap.salon_id
    AND b.group_id=v_cap.group_id ORDER BY b.id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.bookings b WHERE b.salon_id=v_cap.salon_id
    AND b.group_id=v_cap.group_id AND (b.deleted_at IS NOT NULL OR b.status NOT IN ('pending','confirmed'))) THEN
    RETURN jsonb_build_object('ok',false,'code','booking_state_changed');
  END IF;
  IF p_expected_action='group_reschedule' THEN
    IF jsonb_array_length(p_member_slots)<>v_group_state.member_count
       OR (SELECT count(DISTINCT (e->>'booking_id')::uuid) FROM jsonb_array_elements(p_member_slots)e)
          <>v_group_state.member_count
       OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_member_slots)e
         WHERE coalesce(e->>'booking_id','') !~ '^[0-9a-f-]{36}$'
           OR coalesce(e->>'start_time_utc','')='' OR coalesce(e->>'end_time_utc','')='')
       OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_member_slots)e
         WHERE NOT EXISTS(SELECT 1 FROM public.bookings b WHERE b.id=(e->>'booking_id')::uuid
           AND b.salon_id=v_cap.salon_id AND b.group_id=v_cap.group_id)) THEN
      RETURN jsonb_build_object('ok',false,'code','invalid_slot');
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_member_slots)e
      WHERE (e->>'start_time_utc')::timestamptz<=v_now
         OR (e->>'end_time_utc')::timestamptz<=(e->>'start_time_utc')::timestamptz
         OR (e->>'end_time_utc')::timestamptz-(e->>'start_time_utc')::timestamptz>interval '24 hours') THEN
      RETURN jsonb_build_object('ok',false,'code','invalid_slot');
    END IF;
    IF EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_member_slots)a
      JOIN jsonb_array_elements(p_member_slots)b ON a->>'booking_id'<b->>'booking_id'
      JOIN public.bookings ba ON ba.id=(a->>'booking_id')::uuid
      JOIN public.bookings bb ON bb.id=(b->>'booking_id')::uuid
      WHERE ba.staff_id=bb.staff_id
        AND (a->>'start_time_utc')::timestamptz<(b->>'end_time_utc')::timestamptz
        AND (a->>'end_time_utc')::timestamptz>(b->>'start_time_utc')::timestamptz
    ) OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_member_slots)e
      JOIN public.bookings own ON own.id=(e->>'booking_id')::uuid
      JOIN public.bookings other ON other.salon_id=own.salon_id AND other.staff_id=own.staff_id
        AND other.id<>own.id AND other.group_id IS DISTINCT FROM v_cap.group_id
        AND other.deleted_at IS NULL AND other.status<>'cancelled'
        AND other.start_time_utc<(e->>'end_time_utc')::timestamptz
        AND other.end_time_utc>(e->>'start_time_utc')::timestamptz
    ) THEN RETURN jsonb_build_object('ok',false,'code','slot_conflict'); END IF;
    FOR v_slot IN SELECT e FROM jsonb_array_elements(p_member_slots)e ORDER BY e->>'booking_id' LOOP
      SELECT * INTO STRICT v_booking FROM public.bookings
      WHERE id=(v_slot->>'booking_id')::uuid AND salon_id=v_cap.salon_id AND group_id=v_cap.group_id;
      BEGIN
        UPDATE public.bookings SET rescheduled_from_time_utc=start_time_utc,
          start_time_utc=(v_slot->>'start_time_utc')::timestamptz,
          end_time_utc=(v_slot->>'end_time_utc')::timestamptz,rescheduled_at=v_now,
          rescheduled_by='customer',reminder_24h_sent_at=NULL,reminder_3h_sent_at=NULL,
          status='confirmed',customer_transition_email_requested=true,
          customer_transition_email_not_before=v_now WHERE id=v_booking.id
        RETURNING customer_transition_version INTO v_transition;
      EXCEPTION WHEN exclusion_violation THEN
        RETURN jsonb_build_object('ok',false,'code','slot_conflict');
      END;
      PERFORM public.activate_customer_booking_transition_email(
        v_booking.salon_id,v_booking.id,'reschedule',v_transition,v_now);
      v_transitions:=v_transitions||jsonb_build_array(jsonb_build_object(
        'booking_id',v_booking.id,'customer_transition_version',v_transition));
    END LOOP;
  ELSE
    FOR v_booking IN SELECT b.* FROM public.bookings b WHERE b.salon_id=v_cap.salon_id
      AND b.group_id=v_cap.group_id ORDER BY b.id LOOP
      UPDATE public.bookings SET status='cancelled',customer_transition_email_requested=true,
        customer_transition_email_not_before=v_now WHERE id=v_booking.id
      RETURNING customer_transition_version INTO v_transition;
      PERFORM public.activate_customer_booking_transition_email(
        v_booking.salon_id,v_booking.id,'cancel',v_transition,v_now);
      v_transitions:=v_transitions||jsonb_build_array(jsonb_build_object(
        'booking_id',v_booking.id,'customer_transition_version',v_transition));
    END LOOP;
  END IF;
  SELECT jsonb_agg(b.id ORDER BY b.is_group_organizer DESC,b.created_at,b.id) INTO v_booking_ids
  FROM public.bookings b WHERE b.salon_id=v_cap.salon_id AND b.group_id=v_cap.group_id;
  v_result:=jsonb_build_object('ok',true,'code',CASE WHEN p_expected_action='group_reschedule'
      THEN 'group_rescheduled' ELSE 'group_cancelled' END,'action',p_expected_action,
    'salon_id',v_cap.salon_id,'group_id',v_cap.group_id,'organizer_booking_id',v_cap.booking_id,
    'booking_ids',v_booking_ids,'member_count',v_group_state.member_count,
    'party_version',v_group_state.party_version,'transitions',v_transitions,
    'action_epoch',v_cap.epoch,'idempotent',false);
  v_result_hash:=encode(extensions.digest(pg_catalog.convert_to(v_result::text,'UTF8'),'sha256'),'hex');
  UPDATE public.booking_management_capabilities SET consumed_at=v_now,request_id=p_request_id,
    payload_fingerprint=v_payload_hash,result_json=v_result,result_fingerprint=v_result_hash,
    revoke_reason='action_consumed',updated_at=v_now WHERE id=v_cap.id;
  UPDATE public.booking_management_action_state SET epoch=epoch+1,updated_at=v_now
  WHERE salon_id=v_cap.salon_id AND booking_id=v_cap.booking_id AND action=v_cap.action;
  INSERT INTO public.booking_management_action_receipts(capability_id,salon_id,booking_id,group_id,
    action,request_id,action_epoch,payload_fingerprint,result_fingerprint)
  VALUES(v_cap.id,v_cap.salon_id,v_cap.booking_id,v_cap.group_id,v_cap.action,p_request_id,
    v_cap.epoch,v_payload_hash,v_result_hash);
  IF p_expected_action='group_cancel' THEN
    UPDATE public.booking_management_capabilities c SET revoked_at=v_now,
      revoke_reason='group_cancelled',updated_at=v_now
    WHERE c.salon_id=v_cap.salon_id AND c.consumed_at IS NULL AND c.revoked_at IS NULL
      AND c.id<>v_cap.id AND c.action NOT IN ('status','group_status')
      AND (c.group_id=v_cap.group_id OR EXISTS(SELECT 1 FROM public.bookings b
        WHERE b.id=c.booking_id AND b.salon_id=v_cap.salon_id AND b.group_id=v_cap.group_id));
  END IF;
  RETURN v_result;
END;
$group_apply$;

CREATE OR REPLACE FUNCTION public.reschedule_group_booking_with_management_capability(
  p_token_id uuid,p_request_id uuid,p_member_slots jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO '' AS $$
  SELECT public.booking_management_apply_group(p_token_id,p_request_id,'group_reschedule',p_member_slots)
$$;
CREATE OR REPLACE FUNCTION public.cancel_group_booking_with_management_capability(
  p_token_id uuid,p_request_id uuid
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO '' AS $$
  SELECT public.booking_management_apply_group(p_token_id,p_request_id,'group_cancel',NULL)
$$;

REVOKE ALL ON FUNCTION public.booking_management_apply_group(uuid,uuid,text,jsonb),
  public.reschedule_group_booking_with_management_capability(uuid,uuid,jsonb),
  public.cancel_group_booking_with_management_capability(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.booking_management_apply_group(uuid,uuid,text,jsonb),
  public.reschedule_group_booking_with_management_capability(uuid,uuid,jsonb),
  public.cancel_group_booking_with_management_capability(uuid,uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_booking_card_management_operation(
  p_token_id uuid,p_request_id uuid,p_expected_card_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $card_claim$
DECLARE v_cap public.booking_management_capabilities%ROWTYPE;
  v_state public.booking_management_action_state%ROWTYPE; v_booking public.bookings%ROWTYPE;
  v_existing public.booking_card_management_operations%ROWTYPE; v_operation public.booking_card_management_operations%ROWTYPE;
  v_booking_id uuid; v_group_id uuid; v_fp text; v_token uuid:=extensions.gen_random_uuid();
  v_now timestamptz:=transaction_timestamp(); v_result jsonb; v_payload text;
  v_result_hash text; v_provider_material jsonb;
BEGIN
  IF p_token_id IS NULL OR p_request_id IS NULL
     OR coalesce(p_expected_card_fingerprint,'')!~'^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_request');
  END IF;
  SELECT booking_id INTO v_booking_id FROM public.booking_management_capabilities WHERE id=p_token_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','invalid_token'); END IF;
  SELECT group_id INTO v_group_id FROM public.bookings WHERE id=v_booking_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE
    WHEN v_group_id IS NULL THEN 'booking-management:'||v_booking_id::text
    ELSE 'booking-management-group:'||v_group_id::text END,0));
  SELECT * INTO v_cap FROM public.booking_management_capabilities WHERE id=p_token_id FOR UPDATE;
  IF NOT FOUND OR v_cap.action<>'card_manage' THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_token');
  END IF;
  IF EXISTS(SELECT 1 FROM public.booking_card_save_operations WHERE capability_id=p_token_id) THEN
    RETURN jsonb_build_object('ok',false,'code','operation_conflict');
  END IF;
  SELECT * INTO v_existing FROM public.booking_card_management_operations
  WHERE capability_id=p_token_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_id<>p_request_id OR v_existing.card_fingerprint<>p_expected_card_fingerprint THEN
      RETURN jsonb_build_object('ok',false,'code','idempotency_mismatch');
    END IF;
    IF v_existing.status='sending' THEN RETURN jsonb_build_object('ok',true,'code','claimed',
      'operation_id',v_existing.id,'attempt_token',v_existing.attempt_token,
      'booking_id',v_existing.booking_id,'salon_id',v_existing.salon_id,
      'provider_material',v_existing.provider_material,'card_fingerprint',v_existing.card_fingerprint,
      'provider_idempotency_key',v_existing.id::text,'attempt_replay',true); END IF;
    RETURN v_existing.result_json||jsonb_build_object('idempotent',true);
  END IF;
  IF v_cap.consumed_at IS NOT NULL OR v_cap.revoked_at IS NOT NULL OR v_cap.expires_at<=v_now THEN
    RETURN jsonb_build_object('ok',false,'code','expired_or_revoked');
  END IF;
  SELECT * INTO v_state FROM public.booking_management_action_state
  WHERE salon_id=v_cap.salon_id AND booking_id=v_cap.booking_id AND action='card_manage' FOR UPDATE;
  IF NOT FOUND OR v_state.epoch<>v_cap.epoch THEN
    RETURN jsonb_build_object('ok',false,'code','stale_epoch');
  END IF;
  SELECT * INTO v_booking FROM public.bookings
  WHERE id=v_cap.booking_id AND salon_id=v_cap.salon_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','booking_state_changed'); END IF;
  v_fp:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'card_id',v_booking.noshow_card_id,'customer_id',v_booking.noshow_customer_id,
    'charge_status',v_booking.noshow_charge_status)::text,'UTF8'),'sha256'),'hex');
  IF v_fp<>p_expected_card_fingerprint OR v_fp<>v_cap.card_state_fingerprint THEN
    RETURN jsonb_build_object('ok',false,'code','stale_card');
  END IF;
  IF v_booking.noshow_charge_status='charged' THEN
    RETURN jsonb_build_object('ok',false,'code','already_charged');
  END IF;
  IF v_booking.noshow_card_id IS NULL THEN
    v_result:=jsonb_build_object('ok',true,'code','already_removed','booking_id',v_booking.id,
      'salon_id',v_booking.salon_id,'idempotent',false);
    v_payload:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
      'operation','remove_card','card_fingerprint',v_fp)::text,'UTF8'),'sha256'),'hex');
    v_result_hash:=encode(extensions.digest(pg_catalog.convert_to(v_result::text,'UTF8'),'sha256'),'hex');
    INSERT INTO public.booking_card_management_operations(capability_id,salon_id,booking_id,
      request_id,operation,card_fingerprint,provider_material,status,attempt_token,result_json,completed_at)
    VALUES(v_cap.id,v_cap.salon_id,v_cap.booking_id,p_request_id,'remove_card',v_fp,
      '{}'::jsonb,'succeeded',v_token,v_result,v_now);
    UPDATE public.booking_management_capabilities SET consumed_at=v_now,request_id=p_request_id,
      payload_fingerprint=v_payload,result_json=v_result,result_fingerprint=v_result_hash,
      revoke_reason='action_consumed',updated_at=v_now WHERE id=v_cap.id;
    UPDATE public.booking_management_action_state SET epoch=epoch+1,updated_at=v_now
    WHERE salon_id=v_cap.salon_id AND booking_id=v_cap.booking_id AND action='card_manage';
    INSERT INTO public.booking_management_action_receipts(capability_id,salon_id,booking_id,
      action,request_id,action_epoch,payload_fingerprint,result_fingerprint)
    VALUES(v_cap.id,v_cap.salon_id,v_cap.booking_id,'card_manage',p_request_id,v_cap.epoch,v_payload,v_result_hash);
    RETURN v_result;
  END IF;
  v_provider_material:=jsonb_build_object('card_id',v_booking.noshow_card_id,
    'customer_id',coalesce(v_booking.noshow_customer_id,''));
  INSERT INTO public.booking_card_management_operations(capability_id,salon_id,booking_id,
    request_id,operation,card_fingerprint,provider_material,status,attempt_token)
  VALUES(v_cap.id,v_cap.salon_id,v_cap.booking_id,p_request_id,'remove_card',v_fp,
    v_provider_material,'sending',v_token)
  RETURNING * INTO v_operation;
  RETURN jsonb_build_object('ok',true,'code','claimed','operation_id',v_operation.id,
    'attempt_token',v_token,'booking_id',v_booking.id,'salon_id',v_booking.salon_id,
    'provider_material',v_provider_material,'card_fingerprint',v_fp,
    'provider_idempotency_key',v_operation.id::text,'attempt_replay',false);
END;
$card_claim$;

CREATE OR REPLACE FUNCTION public.complete_booking_card_management_operation(
  p_operation_id uuid,p_attempt_token uuid,p_outcome text,p_provider_reference text,p_error_code text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $card_complete$
DECLARE v_operation public.booking_card_management_operations%ROWTYPE;
  v_cap public.booking_management_capabilities%ROWTYPE; v_booking public.bookings%ROWTYPE;
  v_booking_id uuid; v_group_id uuid; v_fp text; v_now timestamptz:=transaction_timestamp();
  v_result jsonb; v_payload text; v_result_hash text;
  v_outcome text:=p_outcome; v_error_code text:=nullif(trim(coalesce(p_error_code,'')),'');
BEGIN
  IF p_operation_id IS NULL OR p_attempt_token IS NULL
     OR p_outcome NOT IN ('succeeded','failed','unknown')
     OR (p_outcome='succeeded' AND (coalesce(trim(p_provider_reference),'')=''
       OR length(trim(p_provider_reference))>255 OR trim(p_provider_reference)!~'^[[:graph:]]+$'))
     OR (p_outcome IN ('failed','unknown') AND (coalesce(trim(p_error_code),'')=''
       OR length(trim(p_error_code))>100 OR trim(p_error_code)!~'^[a-z0-9_]+$')) THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_completion');
  END IF;
  SELECT booking_id INTO v_booking_id FROM public.booking_card_management_operations WHERE id=p_operation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','operation_not_found'); END IF;
  SELECT group_id INTO v_group_id FROM public.bookings WHERE id=v_booking_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE
    WHEN v_group_id IS NULL THEN 'booking-management:'||v_booking_id::text
    ELSE 'booking-management-group:'||v_group_id::text END,0));
  SELECT * INTO v_operation FROM public.booking_card_management_operations WHERE id=p_operation_id FOR UPDATE;
  IF v_operation.attempt_token<>p_attempt_token THEN RETURN jsonb_build_object('ok',false,'code','claim_mismatch'); END IF;
  IF v_operation.status<>'sending' THEN
    IF (v_operation.status=p_outcome
          AND coalesce(v_operation.provider_reference,'')=coalesce(nullif(trim(coalesce(p_provider_reference,'')),''),'')
          AND coalesce(v_operation.error_code,'')=coalesce(nullif(trim(coalesce(p_error_code,'')),''),''))
       OR (v_operation.status='unknown' AND p_outcome='succeeded'
          AND v_operation.error_code='card_state_changed_after_provider'
          AND coalesce(v_operation.provider_reference,'')=coalesce(trim(p_provider_reference),'')) THEN
      RETURN v_operation.result_json||jsonb_build_object('idempotent',true);
    END IF;
    RETURN jsonb_build_object('ok',false,'code','completion_conflict');
  END IF;
  SELECT * INTO STRICT v_cap FROM public.booking_management_capabilities WHERE id=v_operation.capability_id FOR UPDATE;
  SELECT * INTO STRICT v_booking FROM public.bookings
  WHERE id=v_operation.booking_id AND salon_id=v_operation.salon_id FOR UPDATE;
  v_fp:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'card_id',v_booking.noshow_card_id,'customer_id',v_booking.noshow_customer_id,
    'charge_status',v_booking.noshow_charge_status)::text,'UTF8'),'sha256'),'hex');
  IF v_outcome='succeeded' AND v_fp<>v_operation.card_fingerprint THEN v_outcome:='unknown';
    v_error_code:='card_state_changed_after_provider'; END IF;
  IF v_outcome='succeeded' THEN
    UPDATE public.bookings SET noshow_card_id=NULL,noshow_customer_id=NULL,
      noshow_charge_status='removed_by_customer' WHERE id=v_booking.id;
  END IF;
  v_result:=jsonb_build_object('ok',v_outcome='succeeded','code',CASE v_outcome
      WHEN 'succeeded' THEN 'removed' WHEN 'failed' THEN 'remove_failed' ELSE 'remove_unknown' END,
    'booking_id',v_booking.id,'salon_id',v_booking.salon_id,'outcome',v_outcome,'idempotent',false);
  v_payload:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'operation','remove_card','card_fingerprint',v_operation.card_fingerprint)::text,'UTF8'),'sha256'),'hex');
  v_result_hash:=encode(extensions.digest(pg_catalog.convert_to(v_result::text,'UTF8'),'sha256'),'hex');
  UPDATE public.booking_card_management_operations SET status=v_outcome,
    provider_reference=nullif(trim(coalesce(p_provider_reference,'')),''),
    error_code=v_error_code,result_json=v_result,
    completed_at=v_now,updated_at=v_now WHERE id=v_operation.id;
  UPDATE public.booking_management_capabilities SET consumed_at=v_now,request_id=v_operation.request_id,
    payload_fingerprint=v_payload,result_json=v_result,result_fingerprint=v_result_hash,
    revoke_reason='action_consumed',updated_at=v_now WHERE id=v_cap.id;
  UPDATE public.booking_management_action_state SET epoch=epoch+1,updated_at=v_now
  WHERE salon_id=v_cap.salon_id AND booking_id=v_cap.booking_id AND action='card_manage';
  INSERT INTO public.booking_management_action_receipts(capability_id,salon_id,booking_id,
    action,request_id,action_epoch,payload_fingerprint,result_fingerprint)
  VALUES(v_cap.id,v_cap.salon_id,v_cap.booking_id,'card_manage',v_operation.request_id,
    v_cap.epoch,v_payload,v_result_hash);
  RETURN v_result;
END;
$card_complete$;

CREATE OR REPLACE FUNCTION public.reconcile_stale_booking_card_management_operations(p_limit integer)
RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $card_reconcile$
DECLARE v_row public.booking_card_management_operations%ROWTYPE; v_limit integer:=least(greatest(coalesce(p_limit,0),0),100);
BEGIN
  FOR v_row IN SELECT * FROM public.booking_card_management_operations
    WHERE status='sending' AND created_at<transaction_timestamp()-interval '5 minutes'
    ORDER BY created_at,id LIMIT v_limit
  LOOP
    RETURN NEXT jsonb_build_object('ok',true,'code','reconcile_required',
      'operation_id',v_row.id,'attempt_token',v_row.attempt_token,
      'booking_id',v_row.booking_id,'salon_id',v_row.salon_id,
      'provider_material',v_row.provider_material,'card_fingerprint',v_row.card_fingerprint,
      'provider_idempotency_key',v_row.id::text,'attempt_replay',true);
  END LOOP;
END;
$card_reconcile$;

REVOKE ALL ON FUNCTION public.claim_booking_card_management_operation(uuid,uuid,text),
  public.complete_booking_card_management_operation(uuid,uuid,text,text,text),
  public.reconcile_stale_booking_card_management_operations(integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_booking_card_management_operation(uuid,uuid,text),
  public.complete_booking_card_management_operation(uuid,uuid,text,text,text),
  public.reconcile_stale_booking_card_management_operations(integer)
  TO service_role;

CREATE TABLE public.booking_card_save_operations (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  capability_id uuid NOT NULL REFERENCES public.booking_management_capabilities(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider IN ('square','stripe')),
  mode text NOT NULL CHECK(mode IN ('save_card','setup_intent')),
  source_fingerprint text NOT NULL CHECK(source_fingerprint~'^[0-9a-f]{64}$'),
  initial_card_fingerprint text NOT NULL CHECK(initial_card_fingerprint~'^[0-9a-f]{64}$'),
  provider_material jsonb NOT NULL CHECK(jsonb_typeof(provider_material)='object'),
  status text NOT NULL CHECK(status IN ('sending','succeeded','failed','unknown')),
  attempt_token uuid NOT NULL,
  provider_reference text CHECK(provider_reference IS NULL OR
    (length(provider_reference) BETWEEN 1 AND 255 AND provider_reference~'^[[:graph:]]+$')),
  completion_fingerprint text CHECK(completion_fingerprint IS NULL OR completion_fingerprint~'^[0-9a-f]{64}$'),
  error_code text CHECK(error_code IS NULL OR
    (length(error_code) BETWEEN 1 AND 100 AND error_code~'^[a-z0-9_]+$')),
  result_json jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(capability_id),UNIQUE(capability_id,request_id),
  CONSTRAINT booking_card_save_operation_mode_check CHECK(
    (provider='square' AND mode='save_card')
      OR (provider='stripe' AND mode IN ('setup_intent','save_card'))),
  CONSTRAINT booking_card_save_operation_completion_check CHECK(
    (status='sending' AND completed_at IS NULL AND result_json IS NULL
      AND provider_reference IS NULL AND completion_fingerprint IS NULL AND error_code IS NULL)
    OR (status='succeeded' AND completed_at IS NOT NULL AND result_json IS NOT NULL
      AND provider_reference IS NOT NULL AND completion_fingerprint IS NOT NULL)
    OR (status IN ('failed','unknown') AND completed_at IS NOT NULL AND result_json IS NOT NULL
      AND completion_fingerprint IS NOT NULL AND error_code IS NOT NULL))
);
CREATE INDEX idx_booking_card_save_operations_stale
  ON public.booking_card_save_operations(created_at,id) WHERE status='sending';
ALTER TABLE public.booking_card_save_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.booking_card_save_operations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.booking_card_save_operations TO service_role;
CREATE POLICY "deny direct api booking card save operations" ON public.booking_card_save_operations
  AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

CREATE OR REPLACE FUNCTION public.claim_booking_card_save_operation(
  p_token_id uuid,p_request_id uuid,p_provider text,p_mode text,p_source_fingerprint text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $save_claim$
DECLARE v_cap public.booking_management_capabilities%ROWTYPE;
  v_state public.booking_management_action_state%ROWTYPE; v_booking public.bookings%ROWTYPE;
  v_existing public.booking_card_save_operations%ROWTYPE; v_operation public.booking_card_save_operations%ROWTYPE;
  v_booking_id uuid; v_group_id uuid; v_fp text; v_token uuid:=extensions.gen_random_uuid();
  v_salon public.salons%ROWTYPE; v_provider_material jsonb;
BEGIN
  IF p_token_id IS NULL OR p_request_id IS NULL OR p_provider NOT IN ('square','stripe')
     OR p_mode NOT IN ('save_card','setup_intent')
     OR (p_provider='square' AND p_mode<>'save_card')
     OR (p_provider='stripe' AND p_mode NOT IN ('setup_intent','save_card'))
     OR coalesce(p_source_fingerprint,'')!~'^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_request');
  END IF;
  SELECT booking_id INTO v_booking_id FROM public.booking_management_capabilities WHERE id=p_token_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','invalid_token'); END IF;
  SELECT group_id INTO v_group_id FROM public.bookings WHERE id=v_booking_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE
    WHEN v_group_id IS NULL THEN 'booking-management:'||v_booking_id::text
    ELSE 'booking-management-group:'||v_group_id::text END,0));
  SELECT * INTO v_cap FROM public.booking_management_capabilities WHERE id=p_token_id FOR UPDATE;
  IF NOT FOUND OR v_cap.action<>'card_manage' THEN RETURN jsonb_build_object('ok',false,'code','invalid_token'); END IF;
  IF EXISTS(SELECT 1 FROM public.booking_card_management_operations WHERE capability_id=p_token_id) THEN
    RETURN jsonb_build_object('ok',false,'code','operation_conflict');
  END IF;
  SELECT * INTO v_existing FROM public.booking_card_save_operations WHERE capability_id=p_token_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_id<>p_request_id OR v_existing.provider<>p_provider
       OR v_existing.mode<>p_mode OR v_existing.source_fingerprint<>p_source_fingerprint THEN
      RETURN jsonb_build_object('ok',false,'code','idempotency_mismatch');
    END IF;
    IF v_existing.status='sending' THEN RETURN jsonb_build_object('ok',true,'code','claimed',
      'operation_id',v_existing.id,'attempt_token',v_existing.attempt_token,
      'provider',v_existing.provider,'mode',v_existing.mode,
      'booking_id',v_existing.booking_id,'salon_id',v_existing.salon_id,
      'provider_material',v_existing.provider_material,
      'source_fingerprint',v_existing.source_fingerprint,
      'initial_card_fingerprint',v_existing.initial_card_fingerprint,
      'provider_idempotency_key',v_existing.id::text,'attempt_replay',true); END IF;
    RETURN v_existing.result_json||jsonb_build_object('idempotent',true);
  END IF;
  IF v_cap.consumed_at IS NOT NULL OR v_cap.revoked_at IS NOT NULL
     OR v_cap.expires_at<=transaction_timestamp() THEN
    RETURN jsonb_build_object('ok',false,'code','expired_or_revoked');
  END IF;
  SELECT * INTO v_state FROM public.booking_management_action_state
  WHERE salon_id=v_cap.salon_id AND booking_id=v_cap.booking_id AND action='card_manage' FOR UPDATE;
  IF NOT FOUND OR v_state.epoch<>v_cap.epoch THEN RETURN jsonb_build_object('ok',false,'code','stale_epoch'); END IF;
  SELECT * INTO v_booking FROM public.bookings
  WHERE id=v_cap.booking_id AND salon_id=v_cap.salon_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_booking.status='cancelled' OR v_booking.start_time_utc<=transaction_timestamp() THEN
    RETURN jsonb_build_object('ok',false,'code','booking_state_changed');
  END IF;
  v_fp:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'card_id',v_booking.noshow_card_id,'customer_id',v_booking.noshow_customer_id,
    'charge_status',v_booking.noshow_charge_status)::text,'UTF8'),'sha256'),'hex');
  IF v_fp<>v_cap.card_state_fingerprint THEN RETURN jsonb_build_object('ok',false,'code','stale_card'); END IF;
  IF v_booking.noshow_card_id IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'code','already_saved'); END IF;
  IF p_provider='stripe' AND p_mode='save_card' AND NOT EXISTS(
      SELECT 1 FROM public.booking_card_save_operations prior
      WHERE prior.booking_id=v_booking.id AND prior.salon_id=v_booking.salon_id
        AND prior.provider='stripe' AND prior.mode='setup_intent' AND prior.status='succeeded'
        AND prior.result_json->>'finalize_token_id'=p_token_id::text) THEN
    RETURN jsonb_build_object('ok',false,'code','setup_not_authorized');
  END IF;
  SELECT * INTO STRICT v_salon FROM public.salons WHERE id=v_booking.salon_id;
  v_provider_material:=jsonb_build_object('client_name',v_booking.client_name,
    'client_phone',v_booking.client_phone,'client_email',v_booking.client_email,
    'group_id',v_booking.group_id,'fee_cents',greatest(0,coalesce(v_booking.noshow_fee_cents,0)),
    'currency',v_salon.currency_code,'salon_name',v_salon.name,
    'cancellation_policy',v_salon.cancellation_policy);
  INSERT INTO public.booking_card_save_operations(capability_id,salon_id,booking_id,request_id,
    provider,mode,source_fingerprint,initial_card_fingerprint,provider_material,status,attempt_token)
  VALUES(v_cap.id,v_cap.salon_id,v_cap.booking_id,p_request_id,p_provider,p_mode,
    p_source_fingerprint,v_fp,v_provider_material,'sending',v_token) RETURNING * INTO v_operation;
  RETURN jsonb_build_object('ok',true,'code','claimed','operation_id',v_operation.id,
    'attempt_token',v_token,'provider',p_provider,'mode',p_mode,
    'booking_id',v_booking.id,'salon_id',v_booking.salon_id,
    'provider_material',v_provider_material,'source_fingerprint',p_source_fingerprint,
    'initial_card_fingerprint',v_fp,'provider_idempotency_key',v_operation.id::text,
    'attempt_replay',false);
END;
$save_claim$;

CREATE OR REPLACE FUNCTION public.complete_booking_card_save_operation(
  p_operation_id uuid,p_attempt_token uuid,p_outcome text,p_provider_reference text,
  p_card_id text,p_customer_id text,p_card_brand text,p_card_last4 text,
  p_consent_at timestamptz,p_consent_meta jsonb,p_error_code text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $save_complete$
DECLARE v_op public.booking_card_save_operations%ROWTYPE; v_cap public.booking_management_capabilities%ROWTYPE;
  v_booking public.bookings%ROWTYPE; v_booking_id uuid; v_group_id uuid; v_current_fp text;
  v_outcome text:=p_outcome; v_error text:=nullif(trim(coalesce(p_error_code,'')),'');
  v_provider_ref text:=nullif(trim(coalesce(p_provider_reference,'')),'');
  v_completion text; v_payload text; v_result_hash text; v_result jsonb; v_next jsonb;
  v_now timestamptz:=transaction_timestamp();
BEGIN
  IF p_operation_id IS NULL OR p_attempt_token IS NULL OR p_outcome NOT IN ('succeeded','failed','unknown')
     OR (p_outcome='succeeded' AND (v_provider_ref IS NULL OR length(v_provider_ref)>255
       OR v_provider_ref!~'^[[:graph:]]+$'))
     OR (p_outcome IN ('failed','unknown') AND (v_error IS NULL OR length(v_error)>100
       OR v_error!~'^[a-z0-9_]+$')) THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_completion');
  END IF;
  SELECT booking_id INTO v_booking_id FROM public.booking_card_save_operations WHERE id=p_operation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','operation_not_found'); END IF;
  SELECT group_id INTO v_group_id FROM public.bookings WHERE id=v_booking_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE
    WHEN v_group_id IS NULL THEN 'booking-management:'||v_booking_id::text
    ELSE 'booking-management-group:'||v_group_id::text END,0));
  SELECT * INTO v_op FROM public.booking_card_save_operations WHERE id=p_operation_id FOR UPDATE;
  IF v_op.attempt_token<>p_attempt_token THEN RETURN jsonb_build_object('ok',false,'code','claim_mismatch'); END IF;
  v_completion:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'outcome',p_outcome,'provider_reference',v_provider_ref,'card_id',nullif(trim(coalesce(p_card_id,'')),''),
    'customer_id',nullif(trim(coalesce(p_customer_id,'')),''),'card_brand',nullif(trim(coalesce(p_card_brand,'')),''),
    'card_last4',nullif(trim(coalesce(p_card_last4,'')),''),'consent_at',p_consent_at,
    'consent_meta',p_consent_meta,'error_code',v_error)::text,'UTF8'),'sha256'),'hex');
  IF v_op.status<>'sending' THEN
    IF v_op.completion_fingerprint=v_completion THEN RETURN v_op.result_json||jsonb_build_object('idempotent',true); END IF;
    RETURN jsonb_build_object('ok',false,'code','completion_conflict');
  END IF;
  IF p_outcome='succeeded' AND v_op.mode='save_card' AND (
      coalesce(trim(p_card_id),'')='' OR length(trim(p_card_id))>255
      OR coalesce(trim(p_card_last4),'')!~'^[0-9]{4}$'
      OR coalesce(trim(p_card_brand),'')='' OR length(trim(p_card_brand))>50
      OR p_consent_at IS NULL OR p_consent_at<v_op.created_at-interval '5 minutes'
      OR p_consent_at>v_now+interval '5 minutes' OR p_consent_meta IS NULL
      OR jsonb_typeof(p_consent_meta)<>'object') THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_completion');
  END IF;
  IF p_outcome='succeeded' AND v_op.mode='setup_intent'
     AND (p_card_id IS NOT NULL OR p_customer_id IS NOT NULL OR p_card_brand IS NOT NULL
       OR p_card_last4 IS NOT NULL OR p_consent_at IS NOT NULL OR p_consent_meta IS NOT NULL) THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_completion');
  END IF;
  SELECT * INTO STRICT v_cap FROM public.booking_management_capabilities WHERE id=v_op.capability_id FOR UPDATE;
  SELECT * INTO STRICT v_booking FROM public.bookings
  WHERE id=v_op.booking_id AND salon_id=v_op.salon_id FOR UPDATE;
  v_current_fp:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'card_id',v_booking.noshow_card_id,'customer_id',v_booking.noshow_customer_id,
    'charge_status',v_booking.noshow_charge_status)::text,'UTF8'),'sha256'),'hex');
  IF v_outcome='succeeded' AND v_current_fp<>v_op.initial_card_fingerprint THEN
    v_outcome:='unknown'; v_error:='card_state_changed_after_provider';
  END IF;
  IF v_outcome='succeeded' AND v_op.mode='save_card' THEN
    UPDATE public.bookings SET noshow_card_id=trim(p_card_id),
      noshow_customer_id=nullif(trim(coalesce(p_customer_id,'')),''),
      noshow_card_brand=trim(p_card_brand),noshow_card_last4=trim(p_card_last4),
      noshow_consent_at=p_consent_at,noshow_consent_meta=p_consent_meta,
      noshow_charge_status='saved' WHERE id=v_booking.id;
  END IF;
  IF v_outcome='succeeded' AND v_op.mode='setup_intent' THEN
    UPDATE public.booking_management_action_state SET epoch=epoch+1,updated_at=v_now
    WHERE salon_id=v_cap.salon_id AND booking_id=v_cap.booking_id AND action='card_manage';
    v_next:=public.mint_booking_management_capability(v_cap.salon_id,v_cap.booking_id,
      'card_manage',least(v_cap.expires_at,v_now+interval '30 minutes'));
    IF coalesce(v_next->>'ok','false')<>'true' THEN
      RAISE EXCEPTION 'failed to mint Stripe finalize capability: %',v_next->>'code';
    END IF;
  END IF;
  v_result:=jsonb_build_object('ok',v_outcome='succeeded','code',CASE
      WHEN v_outcome='failed' THEN 'save_failed' WHEN v_outcome='unknown' THEN 'save_unknown'
      WHEN v_op.mode='setup_intent' THEN 'setup_created' ELSE 'saved' END,
    'booking_id',v_booking.id,'salon_id',v_booking.salon_id,'provider',v_op.provider,
    'mode',v_op.mode,'outcome',v_outcome,'provider_reference',v_provider_ref,
    'card_brand',CASE WHEN v_op.mode='save_card' AND v_outcome='succeeded' THEN trim(p_card_brand) END,
    'card_last4',CASE WHEN v_op.mode='save_card' AND v_outcome='succeeded' THEN trim(p_card_last4) END,
    'idempotent',false);
  IF v_outcome='succeeded' AND v_op.mode='setup_intent' THEN
    v_result:=v_result||jsonb_build_object('finalize_token_id',v_next->>'token_id',
      'finalize_expires_at',v_next->>'expires_at');
  END IF;
  v_payload:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object('operation','save_card',
    'provider',v_op.provider,'mode',v_op.mode,'source_fingerprint',v_op.source_fingerprint)::text,
    'UTF8'),'sha256'),'hex');
  v_result_hash:=encode(extensions.digest(pg_catalog.convert_to(v_result::text,'UTF8'),'sha256'),'hex');
  UPDATE public.booking_card_save_operations SET status=v_outcome,provider_reference=v_provider_ref,
    completion_fingerprint=v_completion,error_code=v_error,result_json=v_result,
    completed_at=v_now,updated_at=v_now WHERE id=v_op.id;
  UPDATE public.booking_management_capabilities SET consumed_at=v_now,request_id=v_op.request_id,
    payload_fingerprint=v_payload,result_json=v_result,result_fingerprint=v_result_hash,
    revoke_reason='action_consumed',updated_at=v_now WHERE id=v_cap.id;
  IF NOT (v_outcome='succeeded' AND v_op.mode='setup_intent') THEN
    UPDATE public.booking_management_action_state SET epoch=epoch+1,updated_at=v_now
    WHERE salon_id=v_cap.salon_id AND booking_id=v_cap.booking_id AND action='card_manage';
  END IF;
  INSERT INTO public.booking_management_action_receipts(capability_id,salon_id,booking_id,
    action,request_id,action_epoch,payload_fingerprint,result_fingerprint)
  VALUES(v_cap.id,v_cap.salon_id,v_cap.booking_id,'card_manage',v_op.request_id,
    v_cap.epoch,v_payload,v_result_hash);
  RETURN v_result;
END;
$save_complete$;

CREATE OR REPLACE FUNCTION public.reconcile_stale_booking_card_save_operations(p_limit integer)
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $save_reconcile$
DECLARE v_row public.booking_card_save_operations%ROWTYPE;
  v_limit integer:=least(greatest(coalesce(p_limit,0),0),100);
BEGIN
  FOR v_row IN SELECT * FROM public.booking_card_save_operations
    WHERE status='sending' AND created_at<transaction_timestamp()-interval '5 minutes'
    ORDER BY created_at,id LIMIT v_limit
  LOOP
    RETURN NEXT jsonb_build_object('ok',true,'code','reconcile_required',
      'operation_id',v_row.id,'attempt_token',v_row.attempt_token,
      'provider',v_row.provider,'mode',v_row.mode,
      'booking_id',v_row.booking_id,'salon_id',v_row.salon_id,
      'provider_material',v_row.provider_material,
      'source_fingerprint',v_row.source_fingerprint,
      'initial_card_fingerprint',v_row.initial_card_fingerprint,
      'provider_idempotency_key',v_row.id::text,'attempt_replay',true);
  END LOOP;
END;
$save_reconcile$;

REVOKE ALL ON FUNCTION public.claim_booking_card_save_operation(uuid,uuid,text,text,text),
  public.complete_booking_card_save_operation(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text),
  public.reconcile_stale_booking_card_save_operations(integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_booking_card_save_operation(uuid,uuid,text,text,text),
  public.complete_booking_card_save_operation(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text),
  public.reconcile_stale_booking_card_save_operations(integer)
  TO service_role;

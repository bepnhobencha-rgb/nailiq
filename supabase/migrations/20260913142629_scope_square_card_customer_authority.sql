DO $source_guard$
BEGIN
  IF md5(pg_get_functiondef('public.claim_square_card_customer(uuid,uuid)'::regprocedure))<>'6528e3190780c8b93919eb60b91337ea' THEN RAISE EXCEPTION 'R10 source drift: claim_square_card_customer(uuid,uuid)'; END IF;
  IF md5(pg_get_functiondef('public.prepare_square_card_customer(uuid,uuid,uuid,uuid)'::regprocedure))<>'b0665b34fa0fc6f5ec01a430648a4201' THEN RAISE EXCEPTION 'R10 source drift: prepare_square_card_customer(uuid,uuid,uuid,uuid)'; END IF;
  IF md5(pg_get_functiondef('public.complete_square_card_customer(uuid,uuid,uuid,uuid,text,text)'::regprocedure))<>'ffd73ed79e2089cd24f353739401c4ac' THEN RAISE EXCEPTION 'R10 source drift: complete_square_card_customer(uuid,uuid,uuid,uuid,text,text)'; END IF;
  IF md5(pg_get_functiondef('public.claim_booking_card_save_operation(uuid,uuid,text,text,text)'::regprocedure))<>'468ff36101c23cd59e00d03f634554aa' THEN RAISE EXCEPTION 'R10 source drift: claim_booking_card_save_operation(uuid,uuid,text,text,text)'; END IF;
  IF md5(rtrim(pg_get_functiondef('public.bind_booking_card_save_dispatch(uuid,uuid,text,text,text)'::regprocedure), E' \n\r\t'))<>'173bd7e326319eaca61444d7fd43c72c' THEN RAISE EXCEPTION 'R10 source drift: bind_booking_card_save_dispatch(uuid,uuid,text,text,text)'; END IF;
  IF md5(rtrim(pg_get_functiondef('public.record_booking_existing_square_card(uuid,uuid,text,text,text,text,text,text,jsonb)'::regprocedure), E' \n\r\t'))<>'3a716f5a76e7f2918f827505c9f69d58' THEN RAISE EXCEPTION 'R10 source drift: record_booking_existing_square_card(uuid,uuid,text,text,text,text,text,text,jsonb)'; END IF;
END;$source_guard$;

-- A booking capability authorizes that booking, not a contact-based lookup of
-- another Square customer. Legacy delivery material remains immutable.
ALTER TABLE public.square_card_customer_claims
  ADD COLUMN identity_version integer CHECK (identity_version=2),
  ADD COLUMN authority_kind text CHECK (authority_kind IN ('booking','verified_phone')),
  ADD COLUMN authority_fingerprint text CHECK (authority_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN lookup_mode text CHECK (lookup_mode IN ('booking_reference','verified_phone','legacy_reference','legacy_phone')),
  ADD COLUMN identity_authorized boolean NOT NULL DEFAULT false,
  ADD COLUMN identity_rejected_at timestamptz,
  ADD COLUMN source_claim_id uuid REFERENCES public.square_card_customer_claims(id),
  ADD COLUMN source_operation_id uuid REFERENCES public.booking_card_save_operations(id),
  ADD COLUMN lease_operation_id uuid REFERENCES public.booking_card_save_operations(id),
  ADD COLUMN lease_attempt_token uuid,
  ADD CONSTRAINT square_card_customer_authority_shape CHECK (identity_version IS NULL OR
    (authority_kind IS NOT NULL AND authority_fingerprint IS NOT NULL AND lookup_mode IS NOT NULL));

CREATE UNIQUE INDEX square_card_customer_active_authority
  ON public.square_card_customer_claims(salon_id,merchant_id,environment,authority_fingerprint)
  WHERE identity_version=2 AND identity_rejected_at IS NULL;
CREATE INDEX square_card_customer_source_claim
  ON public.square_card_customer_claims(source_claim_id) WHERE source_claim_id IS NOT NULL;

CREATE FUNCTION public.square_card_booking_phone_authorized(p_booking_id uuid,p_salon_id uuid,p_material jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT EXISTS(SELECT 1 FROM public.bookings b JOIN public.phone_otp_sessions s ON s.id=b.otp_session_id
    WHERE b.id=p_booking_id AND b.salon_id=p_salon_id AND b.deleted_at IS NULL
      AND s.verified_channel='sms' AND s.salon_id=b.salon_id AND s.consumed_by_booking_id=b.id
      AND public.canonical_phone(b.client_phone) ~ '^[0-9]{8,15}$'
      AND public.canonical_phone(s.phone)=public.canonical_phone(b.client_phone)
      AND public.canonical_phone(p_material->>'client_phone')=public.canonical_phone(b.client_phone)
      AND s.verified_at IS NOT NULL AND isfinite(s.verified_at)
      AND s.consumed_at IS NOT NULL AND isfinite(s.consumed_at)
      AND s.expires_at IS NOT NULL AND isfinite(s.expires_at)
      AND s.verified_at<=s.consumed_at AND s.consumed_at<s.expires_at
      AND s.consumed_at<=clock_timestamp());
$function$;
REVOKE ALL ON FUNCTION public.square_card_booking_phone_authorized(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- A new attempt may select a different customer only after every older card
-- attempt has definitive terminal evidence. Customer-only uncertainty is kept
-- separately by its original reference and never authorizes blind creation.
CREATE FUNCTION public.square_card_prior_attempts_terminal(p_booking_id uuid,p_operation_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT NOT EXISTS(SELECT 1 FROM public.booking_card_save_operations old
    WHERE old.booking_id=p_booking_id AND old.id<>p_operation_id AND old.provider='square' AND old.mode='save_card'
      AND NOT coalesce(old.status='failed' AND (
        old.dispatch_prepared_at IS NULL
        OR (old.customer_delivery_version=1 AND old.card_dispatch_bound_at IS NULL)
        OR EXISTS(SELECT 1 FROM public.booking_card_delivery_events e WHERE e.operation_id=old.id
          AND ((e.stage='card_create' AND e.retryability='new_card')
            OR (e.stage='reconciliation' AND e.retryability='safe_retry'
              AND e.reconciliation_outcome IN ('disabled_card','retry_exhausted'))))
      ),false));
$function$;
REVOKE ALL ON FUNCTION public.square_card_prior_attempts_terminal(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.claim_square_card_customer(p_operation_id uuid,p_attempt_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE
  v_op public.booking_card_save_operations%ROWTYPE; v_booking public.bookings%ROWTYPE;
  v_claim public.square_card_customer_claims%ROWTYPE; v_source public.square_card_customer_claims%ROWTYPE;
  v_old public.booking_card_save_operations%ROWTYPE;
  v_phone text; v_contact text; v_scope text; v_kind text; v_verified boolean;
  v_id uuid:=extensions.gen_random_uuid(); v_token uuid:=extensions.gen_random_uuid();
  v_now timestamptz; v_count integer; v_mode text; v_material jsonb; v_reference text; v_key text;
  v_candidates uuid[]; v_reference_authorized boolean;
BEGIN
  SELECT * INTO v_op FROM public.booking_card_save_operations WHERE id=p_operation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','claim_mismatch'); END IF;
  SELECT * INTO v_booking FROM public.bookings WHERE id=v_op.booking_id AND salon_id=v_op.salon_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','claim_mismatch'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE WHEN v_booking.group_id IS NULL
    THEN 'booking-management:'||v_booking.id::text ELSE 'booking-management-group:'||v_booking.group_id::text END,0));
  SELECT * INTO v_booking FROM public.bookings WHERE id=v_booking.id AND salon_id=v_op.salon_id FOR UPDATE;
  SELECT * INTO v_op FROM public.booking_card_save_operations WHERE id=p_operation_id FOR UPDATE;
  v_now:=clock_timestamp();
  IF p_attempt_token IS NULL OR v_op.attempt_token IS DISTINCT FROM p_attempt_token
    OR v_op.status<>'sending' OR v_op.provider<>'square' OR v_op.mode<>'save_card'
    OR v_op.dispatch_prepared_at IS NULL OR v_op.created_at<v_now-interval '2 minutes'
    OR v_op.expected_merchant_id IS NULL OR v_op.expected_environment IS NULL
    OR v_op.customer_delivery_version IS DISTINCT FROM 1 OR v_booking.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'code','claim_mismatch');
  END IF;
  v_verified:=public.square_card_booking_phone_authorized(v_op.booking_id,v_op.salon_id,v_op.provider_material);
  v_phone:=public.canonical_phone(v_op.provider_material->>'client_phone');
  v_kind:=CASE WHEN v_verified THEN 'verified_phone' ELSE 'booking' END;
  v_scope:=encode(extensions.digest(convert_to('v2:'||v_kind||':'||CASE WHEN v_verified THEN v_phone ELSE v_op.booking_id::text END,'UTF8'),'sha256'),'hex');
  v_contact:=public.square_card_contact_fingerprint(v_op.provider_material,v_op.booking_id);
  -- Retain the legacy lock before the new scope lock so a cutover cannot race
  -- the original customer request. Neither lock spans a provider request.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('square-card-customer:'||v_op.salon_id::text||':'||
    v_op.expected_merchant_id||':'||v_op.expected_environment||':'||v_contact,0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('square-card-authority:'||v_op.salon_id::text||':'||
    v_op.expected_merchant_id||':'||v_op.expected_environment||':'||v_scope,0));
  SELECT * INTO v_claim FROM public.square_card_customer_claims WHERE salon_id=v_op.salon_id
    AND merchant_id=v_op.expected_merchant_id AND environment=v_op.expected_environment
    AND identity_version=2 AND authority_fingerprint=v_scope AND identity_rejected_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    -- Prefer this booking's exact prior claim. A claim from a different booking
    -- is eligible only under current SMS authority and an exact provider phone read.
    SELECT array_agg(c.id) INTO v_candidates FROM public.square_card_customer_claims c
      JOIN public.booking_card_save_operations anchor ON anchor.id=c.anchor_operation_id
      WHERE c.salon_id=v_op.salon_id AND c.merchant_id=v_op.expected_merchant_id AND c.environment=v_op.expected_environment
        AND c.identity_rejected_at IS NULL AND (c.dispatch_prepared_at IS NOT NULL OR c.customer_id IS NOT NULL)
        AND (anchor.booking_id=v_op.booking_id
          OR EXISTS(SELECT 1 FROM public.booking_card_save_operations attached WHERE attached.booking_id=v_op.booking_id
            AND attached.salon_id=v_op.salon_id AND attached.customer_claim_id=c.id AND attached.id<>v_op.id)
          OR (v_verified AND c.identity_version IS NULL AND c.contact_fingerprint=v_contact))
        AND NOT EXISTS(SELECT 1 FROM public.square_card_customer_claims rejected WHERE rejected.identity_version=2
          AND rejected.authority_fingerprint=v_scope AND rejected.salon_id=v_op.salon_id
          AND rejected.merchant_id=v_op.expected_merchant_id AND rejected.environment=v_op.expected_environment
          AND rejected.source_claim_id=c.id AND rejected.identity_rejected_at IS NOT NULL);
    SELECT count(DISTINCT jsonb_build_object('key',idempotency_key,'reference',reference_id,'body',request_material)) INTO v_count
      FROM public.square_card_customer_claims WHERE id=ANY(v_candidates);
    IF v_count>1 THEN RETURN jsonb_build_object('ok',false,'code','legacy_customer_review_required'); END IF;
    SELECT c.* INTO v_source FROM public.square_card_customer_claims c
      JOIN public.booking_card_save_operations anchor ON anchor.id=c.anchor_operation_id WHERE c.id=ANY(v_candidates)
      ORDER BY (anchor.booking_id=v_op.booking_id) DESC,c.created_at,c.id LIMIT 1 FOR UPDATE OF c;
    IF v_source.id IS NOT NULL AND (v_source.lease_expires_at>clock_timestamp() OR v_source.next_read_at>clock_timestamp()) THEN
      RETURN jsonb_build_object('ok',false,'code','customer_wait');
    END IF;
    IF v_source.id IS NULL THEN
      -- Pre-claim legacy dispatches have no customer row. Adopt one exact key;
      -- multiple keys stay fenced instead of guessing or inventing a new one.
      SELECT count(DISTINCT coalesce(old.provider_material->>'customer_idempotency_key',CASE WHEN old.delivery_version IS NULL
        THEN old.id::text||':customer' ELSE 'sqcust:'||old.booking_id::text END)) INTO v_count
        FROM public.booking_card_save_operations old WHERE old.id<>v_op.id AND old.salon_id=v_op.salon_id
          AND old.provider='square' AND old.mode='save_card' AND old.customer_claim_id IS NULL
          AND old.customer_delivery_version IS NULL AND old.dispatch_prepared_at IS NOT NULL
          AND old.status<>'succeeded' AND old.expected_customer_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM public.square_card_customer_claims rejected WHERE rejected.identity_version=2
            AND rejected.authority_fingerprint=v_scope AND rejected.salon_id=v_op.salon_id
            AND rejected.merchant_id=v_op.expected_merchant_id AND rejected.environment=v_op.expected_environment
            AND rejected.source_operation_id=old.id AND rejected.identity_rejected_at IS NOT NULL)
          AND (old.booking_id=v_op.booking_id OR (v_verified AND public.square_card_contact_fingerprint(old.provider_material,old.booking_id)=v_contact))
          AND (old.expected_merchant_id IS NULL OR old.expected_merchant_id=v_op.expected_merchant_id)
          AND (old.expected_environment IS NULL OR old.expected_environment=v_op.expected_environment);
      IF v_count>1 THEN RETURN jsonb_build_object('ok',false,'code','legacy_customer_review_required'); END IF;
      SELECT * INTO v_old FROM public.booking_card_save_operations old WHERE old.id<>v_op.id AND old.salon_id=v_op.salon_id
        AND old.provider='square' AND old.mode='save_card' AND old.customer_claim_id IS NULL
        AND old.customer_delivery_version IS NULL AND old.dispatch_prepared_at IS NOT NULL
        AND old.status<>'succeeded' AND old.expected_customer_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM public.square_card_customer_claims rejected WHERE rejected.identity_version=2
            AND rejected.authority_fingerprint=v_scope AND rejected.salon_id=v_op.salon_id
            AND rejected.merchant_id=v_op.expected_merchant_id AND rejected.environment=v_op.expected_environment
            AND rejected.source_operation_id=old.id AND rejected.identity_rejected_at IS NOT NULL)
        AND (old.booking_id=v_op.booking_id OR (v_verified AND public.square_card_contact_fingerprint(old.provider_material,old.booking_id)=v_contact))
        AND (old.expected_merchant_id IS NULL OR old.expected_merchant_id=v_op.expected_merchant_id)
        AND (old.expected_environment IS NULL OR old.expected_environment=v_op.expected_environment)
        ORDER BY old.created_at,old.delivery_sequence,old.id LIMIT 1;
    END IF;
    IF v_source.id IS NOT NULL THEN
      SELECT * INTO v_old FROM public.booking_card_save_operations WHERE id=v_source.anchor_operation_id;
      v_material:=v_source.request_material; v_reference:=v_source.reference_id; v_key:=v_source.idempotency_key;
      v_mode:=CASE WHEN v_old.booking_id=v_op.booking_id OR NOT v_verified THEN 'legacy_reference' ELSE 'legacy_phone' END;
    ELSIF v_old.id IS NOT NULL THEN
      v_material:=v_old.provider_material; v_reference:='booking:'||v_old.booking_id::text;
      v_key:=coalesce(v_old.provider_material->>'customer_idempotency_key',CASE WHEN v_old.delivery_version IS NULL
        THEN v_old.id::text||':customer' ELSE 'sqcust:'||v_old.booking_id::text END);
      v_mode:=CASE WHEN v_old.booking_id=v_op.booking_id OR NOT v_verified THEN 'legacy_reference' ELSE 'legacy_phone' END;
    ELSE
      -- Declared email is never customer identity authority. A reference-only
      -- booking customer deliberately has no unverified phone/email to re-import.
      v_material:=jsonb_build_object('client_name',v_op.provider_material->'client_name',
        'client_phone',CASE WHEN v_verified THEN v_phone ELSE NULL END,'client_email',NULL);
      v_reference:='nq-customer:'||v_id::text; v_key:='sqcu:'||v_id::text;
      v_mode:=CASE WHEN v_verified THEN 'verified_phone' ELSE 'booking_reference' END;
    END IF;
    INSERT INTO public.square_card_customer_claims(id,salon_id,merchant_id,environment,contact_fingerprint,anchor_operation_id,
      request_material,reference_id,idempotency_key,status,customer_id,dispatch_prepared_at,empty_read_count,next_read_at,
      identity_version,authority_kind,authority_fingerprint,lookup_mode,source_claim_id,source_operation_id)
    VALUES(v_id,v_op.salon_id,v_op.expected_merchant_id,v_op.expected_environment,
      encode(extensions.digest(convert_to('v2-claim:'||v_id::text,'UTF8'),'sha256'),'hex'),
      coalesce(v_source.anchor_operation_id,v_old.id,v_op.id),v_material,v_reference,v_key,
      CASE WHEN v_source.customer_id IS NOT NULL THEN 'known' WHEN coalesce(v_source.dispatch_prepared_at,v_old.dispatch_prepared_at) IS NOT NULL THEN 'unknown' ELSE 'ready' END,
      v_source.customer_id,coalesce(v_source.dispatch_prepared_at,v_old.dispatch_prepared_at),coalesce(v_source.empty_read_count,0),v_source.next_read_at,
      2,v_kind,v_scope,v_mode,v_source.id,v_old.id) RETURNING * INTO v_claim;
  END IF;
  UPDATE public.booking_card_save_operations SET customer_claim_id=v_claim.id WHERE id=v_op.id;
  v_reference_authorized:=v_verified OR EXISTS(SELECT 1 FROM public.booking_card_save_operations anchor
    WHERE anchor.id=v_claim.anchor_operation_id AND anchor.booking_id=v_op.booking_id AND anchor.salon_id=v_op.salon_id);
  IF v_claim.status='known' AND v_claim.identity_authorized AND v_reference_authorized THEN
    RETURN jsonb_build_object('ok',true,'code','known','identity_version',2,'operation_id',v_op.id,'booking_id',v_op.booking_id,
      'reference_authorized',true,'lookup_mode',CASE WHEN v_claim.authority_kind='verified_phone' THEN 'verified_phone' ELSE 'booking_reference' END,'previously_dispatched',v_claim.dispatch_prepared_at IS NOT NULL,
      'customer_id',v_claim.customer_id,'expected_customer_id',v_claim.customer_id,
      'salon_id',v_claim.salon_id,'merchant_id',v_claim.merchant_id,'environment',v_claim.environment);
  END IF;
  v_now:=clock_timestamp();
  IF v_claim.lease_expires_at>v_now OR v_claim.next_read_at>v_now THEN RETURN jsonb_build_object('ok',false,'code','customer_wait'); END IF;
  -- Only an undispatched fresh claim may refresh its sanitized request body.
  IF v_claim.status='ready' AND v_claim.dispatch_prepared_at IS NULL AND v_claim.source_operation_id IS NULL THEN
    UPDATE public.square_card_customer_claims SET request_material=jsonb_build_object('client_name',v_op.provider_material->'client_name',
      'client_phone',CASE WHEN v_verified THEN v_phone ELSE NULL END,'client_email',NULL) WHERE id=v_claim.id RETURNING * INTO v_claim;
  END IF;
  UPDATE public.square_card_customer_claims SET lease_token=v_token,lease_expires_at=v_now+interval '90 seconds',
    lease_operation_id=v_op.id,lease_attempt_token=v_op.attempt_token,lease_allows_create=(status='ready' AND v_reference_authorized),updated_at=v_now WHERE id=v_claim.id;
  RETURN jsonb_build_object('ok',true,'code',CASE WHEN v_claim.status='known' THEN 'verify_known' ELSE 'claimed_v2' END,
    'identity_version',2,'operation_id',v_op.id,'booking_id',v_op.booking_id,'claim_id',v_claim.id,'lease_token',v_token,
    'allow_create',v_claim.status='ready' AND v_reference_authorized,'lookup_mode',v_claim.lookup_mode,
    'reference_authorized',v_reference_authorized,
    'previously_dispatched',v_claim.dispatch_prepared_at IS NOT NULL,'expected_customer_id',v_claim.customer_id,
    'salon_id',v_claim.salon_id,'merchant_id',v_claim.merchant_id,'environment',v_claim.environment,
    'reference_id',v_claim.reference_id,'idempotency_key',v_claim.idempotency_key,'request_material',v_claim.request_material);
END;$function$;

CREATE OR REPLACE FUNCTION public.prepare_square_card_customer(p_operation_id uuid,p_attempt_token uuid,p_claim_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_op public.booking_card_save_operations%ROWTYPE; v_claim public.square_card_customer_claims%ROWTYPE;
BEGIN
  IF p_lease_token IS NULL OR p_attempt_token IS NULL THEN RETURN jsonb_build_object('ok',false); END IF;
  SELECT * INTO v_op FROM public.booking_card_save_operations WHERE id=p_operation_id;
  SELECT * INTO v_claim FROM public.square_card_customer_claims WHERE id=p_claim_id FOR UPDATE;
  IF v_op.id IS NULL OR v_claim.id IS NULL OR v_op.attempt_token IS DISTINCT FROM p_attempt_token
    OR v_op.customer_claim_id IS DISTINCT FROM p_claim_id OR v_op.status<>'sending' OR v_op.provider<>'square' OR v_op.mode<>'save_card'
    OR v_op.created_at<=clock_timestamp()-interval '2 minutes' OR v_claim.identity_version IS DISTINCT FROM 2
    OR v_claim.identity_rejected_at IS NOT NULL OR v_claim.lease_token IS DISTINCT FROM p_lease_token
    OR v_claim.lease_operation_id IS DISTINCT FROM p_operation_id OR v_claim.lease_attempt_token IS DISTINCT FROM p_attempt_token
    OR v_claim.lease_expires_at IS NULL OR v_claim.lease_expires_at<=clock_timestamp()
    OR v_claim.salon_id<>v_op.salon_id OR v_claim.merchant_id IS DISTINCT FROM v_op.expected_merchant_id
    OR v_claim.environment IS DISTINCT FROM v_op.expected_environment OR v_claim.lease_allows_create IS DISTINCT FROM true
    OR v_claim.status<>'ready' OR (v_claim.authority_kind='booking' AND NOT EXISTS(SELECT 1 FROM public.booking_card_save_operations anchor
      WHERE anchor.id=v_claim.anchor_operation_id AND anchor.booking_id=v_op.booking_id)) OR (v_claim.authority_kind='verified_phone'
      AND NOT public.square_card_booking_phone_authorized(v_op.booking_id,v_op.salon_id,v_op.provider_material)) THEN
    RETURN jsonb_build_object('ok',false);
  END IF;
  UPDATE public.square_card_customer_claims SET status='unknown',dispatch_prepared_at=coalesce(dispatch_prepared_at,clock_timestamp()),
    empty_read_count=0,updated_at=clock_timestamp() WHERE id=p_claim_id;
  RETURN jsonb_build_object('ok',true);
END;$function$;

CREATE OR REPLACE FUNCTION public.complete_square_card_customer(p_operation_id uuid,p_attempt_token uuid,p_claim_id uuid,p_lease_token uuid,
  p_outcome text,p_customer_id text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_op public.booking_card_save_operations%ROWTYPE; v_claim public.square_card_customer_claims%ROWTYPE;
  v_now timestamptz; v_empty integer; v_ready boolean; v_retry boolean;
BEGIN
  IF p_lease_token IS NULL OR p_attempt_token IS NULL OR p_outcome IS NULL OR p_outcome NOT IN
    ('found','not_found','not_dispatched','read_failed','unknown','invalid','identity_not_authorized') THEN RETURN jsonb_build_object('ok',false); END IF;
  SELECT * INTO v_op FROM public.booking_card_save_operations WHERE id=p_operation_id AND attempt_token=p_attempt_token
    AND customer_claim_id=p_claim_id AND provider='square' AND mode='save_card';
  SELECT * INTO v_claim FROM public.square_card_customer_claims WHERE id=p_claim_id FOR UPDATE;
  IF v_op.id IS NULL OR v_claim.id IS NULL OR v_claim.identity_version IS DISTINCT FROM 2
    OR v_claim.identity_rejected_at IS NOT NULL OR v_claim.salon_id<>v_op.salon_id
    OR v_claim.merchant_id IS DISTINCT FROM v_op.expected_merchant_id OR v_claim.environment IS DISTINCT FROM v_op.expected_environment
    OR v_claim.lease_operation_id IS DISTINCT FROM p_operation_id OR v_claim.lease_attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN jsonb_build_object('ok',false);
  END IF;
  IF v_claim.status='known' AND v_claim.identity_authorized AND p_outcome='found' AND v_claim.customer_id=p_customer_id
    AND v_claim.lease_token=p_lease_token THEN RETURN jsonb_build_object('ok',true,'code','known','customer_id',v_claim.customer_id,'idempotent',true); END IF;
  v_now:=clock_timestamp();
  IF v_op.status<>'sending' OR v_claim.lease_token IS DISTINCT FROM p_lease_token OR v_claim.lease_expires_at IS NULL
    OR v_claim.lease_expires_at<=v_now OR (p_outcome='found' AND coalesce(p_customer_id,'') !~ '^[A-Za-z0-9:_-]{1,255}$')
    OR (p_outcome='found' AND v_claim.customer_id IS NOT NULL AND v_claim.customer_id IS DISTINCT FROM p_customer_id)
    OR (p_outcome='not_dispatched' AND v_claim.lease_allows_create IS DISTINCT FROM true)
    OR (p_outcome='found' AND v_claim.authority_kind='booking' AND NOT EXISTS(SELECT 1 FROM public.booking_card_save_operations anchor
      WHERE anchor.id=v_claim.anchor_operation_id AND anchor.booking_id=v_op.booking_id))
    OR (p_outcome='found' AND v_claim.authority_kind='verified_phone'
      AND NOT public.square_card_booking_phone_authorized(v_op.booking_id,v_op.salon_id,v_op.provider_material)) THEN
    RETURN jsonb_build_object('ok',false);
  END IF;
  IF p_outcome='identity_not_authorized' THEN
    IF v_claim.source_operation_id IS NULL THEN RETURN jsonb_build_object('ok',false); END IF;
    v_retry:=v_op.card_dispatch_bound_at IS NULL AND public.square_card_prior_attempts_terminal(v_op.booking_id,v_op.id);
    UPDATE public.square_card_customer_claims SET identity_rejected_at=CASE WHEN v_retry THEN v_now ELSE NULL END,
      status='manual_review',lease_token=NULL,lease_expires_at=NULL,lease_allows_create=false,updated_at=v_now WHERE id=v_claim.id;
    INSERT INTO public.booking_card_delivery_events(operation_id,booking_id,salon_id,provider,stage,code,retryability)
      VALUES(v_op.id,v_op.booking_id,v_op.salon_id,'square','customer_search','customer_identity_not_authorized',
        CASE WHEN v_retry THEN 'safe_retry' ELSE 'manual_review' END);
    RETURN jsonb_build_object('ok',true,'code',CASE WHEN v_retry THEN 'identity_retry_required' ELSE 'identity_review_required' END);
  END IF;
  v_empty:=CASE WHEN p_outcome='not_found' THEN least(20,v_claim.empty_read_count+1)
    WHEN p_outcome IN ('read_failed','unknown') THEN v_claim.empty_read_count ELSE 0 END;
  v_ready:=p_outcome='not_dispatched' OR (p_outcome='not_found' AND v_empty>=3
    AND v_claim.dispatch_prepared_at<=v_now-interval '15 minutes');
  IF v_ready AND p_outcome='not_found' AND v_claim.authority_kind='booking'
    AND NOT EXISTS(SELECT 1 FROM public.booking_card_save_operations anchor WHERE anchor.id=v_claim.anchor_operation_id AND anchor.booking_id=v_op.booking_id) THEN
    v_retry:=v_op.card_dispatch_bound_at IS NULL AND public.square_card_prior_attempts_terminal(v_op.booking_id,v_op.id);
    UPDATE public.square_card_customer_claims SET identity_rejected_at=CASE WHEN v_retry THEN v_now ELSE NULL END,
      status='manual_review',empty_read_count=v_empty,lease_token=NULL,lease_expires_at=NULL,lease_allows_create=false,updated_at=v_now WHERE id=v_claim.id;
    INSERT INTO public.booking_card_delivery_events(operation_id,booking_id,salon_id,provider,stage,code,retryability,reconciliation_outcome)
      VALUES(v_op.id,v_op.booking_id,v_op.salon_id,'square','customer_search','customer_identity_not_found',
        CASE WHEN v_retry THEN 'safe_retry' ELSE 'manual_review' END,'retry_exhausted');
    RETURN jsonb_build_object('ok',true,'code',CASE WHEN v_retry THEN 'identity_retry_required' ELSE 'identity_review_required' END);
  END IF;
  UPDATE public.square_card_customer_claims SET status=CASE WHEN p_outcome='found' THEN 'known'
    WHEN v_ready THEN 'ready' WHEN p_outcome='invalid' THEN 'manual_review' ELSE status END,
    identity_authorized=CASE WHEN p_outcome='found' THEN true ELSE identity_authorized END,
    customer_id=CASE WHEN p_outcome='found' THEN p_customer_id ELSE customer_id END,empty_read_count=v_empty,
    -- Retain the successful lease identity solely for exact completion replay.
    lease_token=CASE WHEN p_outcome='found' THEN lease_token ELSE NULL END,lease_expires_at=NULL,lease_allows_create=false,
    next_read_at=CASE WHEN p_outcome='found' OR v_ready THEN NULL ELSE v_now+interval '5 minutes' END,updated_at=v_now WHERE id=v_claim.id;
  INSERT INTO public.booking_card_delivery_events(operation_id,booking_id,salon_id,provider,stage,code,retryability)
    VALUES(v_op.id,v_op.booking_id,v_op.salon_id,'square',CASE WHEN p_outcome='unknown' THEN 'customer_create' ELSE 'customer_search' END,
      'customer_identity_'||p_outcome,CASE WHEN p_outcome='found' THEN 'none' WHEN v_ready THEN 'safe_retry'
        WHEN p_outcome='invalid' THEN 'manual_review' ELSE 'reconcile_first' END);
  RETURN jsonb_build_object('ok',true,'code',CASE WHEN p_outcome='found' THEN 'known' WHEN v_ready THEN 'ready' ELSE 'customer_wait' END,
    'customer_id',CASE WHEN p_outcome='found' THEN p_customer_id ELSE NULL END);
END;$function$;

REVOKE ALL ON FUNCTION public.claim_square_card_customer(uuid,uuid),public.prepare_square_card_customer(uuid,uuid,uuid,uuid),
  public.complete_square_card_customer(uuid,uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_square_card_customer(uuid,uuid),public.prepare_square_card_customer(uuid,uuid,uuid,uuid),
  public.complete_square_card_customer(uuid,uuid,uuid,uuid,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_booking_card_save_operation(p_token_id uuid, p_request_id uuid, p_provider text, p_mode text, p_source_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_booking public.bookings%ROWTYPE; v_result jsonb; v_first public.booking_card_save_operations%ROWTYPE; v_material jsonb;
BEGIN
 SELECT b.* INTO v_booking FROM public.bookings b JOIN public.booking_management_capabilities c
   ON c.booking_id=b.id AND c.salon_id=b.salon_id WHERE c.id=p_token_id AND c.action='card_manage';
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','invalid_token'); END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE WHEN v_booking.group_id IS NULL
   THEN 'booking-management:'||v_booking.id::text ELSE 'booking-management-group:'||v_booking.group_id::text END,0));
 IF EXISTS(SELECT 1 FROM public.booking_card_save_operations WHERE booking_id=v_booking.id
   AND salon_id=v_booking.salon_id AND status IN ('sending','unknown') AND capability_id<>p_token_id) THEN
   RETURN jsonb_build_object('ok',false,'code','reconciliation_required'); END IF;
 v_result:=public.claim_booking_card_save_operation_pre_delivery_truth(p_token_id,p_request_id,p_provider,p_mode,p_source_fingerprint);
 IF v_result->>'ok'='true' AND v_result->>'code' IN ('saved','reconciled_saved') THEN
   SELECT * INTO v_booking FROM public.bookings WHERE id=v_booking.id;
   IF public.booking_card_protection_state(v_booking)<>'saved' THEN
     RETURN jsonb_build_object('ok',false,'code','card_state_changed'); END IF;
 END IF;
 IF v_result->>'code'='claimed' AND v_result->>'attempt_replay'='false' THEN
   -- Freeze customer identity only once it is known or a creation may have
   -- reached Square. A proven pre-create failure can use corrected booking
   -- contact on a fresh card attempt. Legacy ambiguity remains conservative.
   SELECT old.* INTO v_first FROM public.booking_card_save_operations old
     WHERE old.booking_id=v_booking.id AND old.salon_id=v_booking.salon_id AND old.provider=p_provider
       AND (old.id=(v_result->>'operation_id')::uuid
         OR (old.customer_delivery_version IS NULL AND old.dispatch_prepared_at IS NOT NULL)
         OR old.card_dispatch_bound_at IS NOT NULL
         OR EXISTS(SELECT 1 FROM public.square_card_customer_claims c WHERE c.id=old.customer_claim_id
           AND (c.dispatch_prepared_at IS NOT NULL OR c.customer_id IS NOT NULL)))
     ORDER BY old.created_at,old.delivery_sequence,old.id LIMIT 1;
   UPDATE public.booking_card_save_operations SET provider_material=provider_material||jsonb_build_object(
     'client_name',v_first.provider_material->'client_name','client_phone',v_first.provider_material->'client_phone',
     'client_email',v_first.provider_material->'client_email',
     'whole_party',(SELECT noshow_group_whole_party FROM public.salons WHERE id=v_booking.salon_id),
     'customer_idempotency_key',CASE WHEN v_first.delivery_version IS NULL THEN v_first.id::text||':customer' ELSE 'sqcust:'||v_booking.id::text END),
     expected_merchant_id=(SELECT expected_merchant_id FROM public.booking_card_save_operations WHERE booking_id=v_booking.id
       AND provider=p_provider AND expected_merchant_id IS NOT NULL ORDER BY created_at,delivery_sequence,id LIMIT 1),
     expected_environment=(SELECT expected_environment FROM public.booking_card_save_operations WHERE booking_id=v_booking.id
       AND provider=p_provider AND expected_environment IS NOT NULL ORDER BY created_at,delivery_sequence,id LIMIT 1),
     expected_customer_id=(SELECT expected_customer_id FROM public.booking_card_save_operations WHERE booking_id=v_booking.id
       AND provider=p_provider AND expected_customer_id IS NOT NULL ORDER BY created_at,delivery_sequence,id LIMIT 1)
   WHERE id=(v_result->>'operation_id')::uuid RETURNING provider_material INTO v_material;
   v_result:=v_result||jsonb_build_object('provider_material',v_material);
   -- A legacy contact lookup is not permanent identity authority. Only this
   -- newly claimed operation may discard an inherited customer after terminal
   -- card evidence; all old operation/customer references remain unchanged.
   IF p_provider='square' AND public.square_card_prior_attempts_terminal(v_booking.id,(v_result->>'operation_id')::uuid) THEN
     UPDATE public.booking_card_save_operations SET expected_customer_id=NULL
       WHERE id=(v_result->>'operation_id')::uuid AND card_dispatch_bound_at IS NULL;
   END IF;
 END IF;
 RETURN v_result;
END; $function$
;

-- Existing-card receipt attachment is atomic and never dispatches CreateCard.
CREATE FUNCTION public.bind_booking_existing_card_receipt(p_operation_id uuid, p_attempt_token uuid, p_customer_id text, p_merchant_id text, p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_op public.booking_card_save_operations%ROWTYPE;
BEGIN
 IF p_attempt_token IS NULL OR coalesce(p_customer_id,'') !~ '^[A-Za-z0-9:_-]{1,255}$'
 OR coalesce(p_merchant_id,'') !~ '^[A-Za-z0-9:_-]{1,255}$'
 OR p_environment IS NULL OR p_environment NOT IN ('sandbox','production') THEN
 RETURN jsonb_build_object('ok',false,'code','invalid_binding'); END IF;
 SELECT * INTO v_op FROM public.booking_card_save_operations WHERE id=p_operation_id FOR UPDATE;
 IF NOT FOUND OR v_op.attempt_token IS DISTINCT FROM p_attempt_token OR v_op.status<>'sending'
 OR v_op.dispatch_prepared_at IS NULL OR v_op.created_at < transaction_timestamp()-interval '2 minutes'
 OR (v_op.expected_customer_id IS NOT NULL AND v_op.expected_customer_id IS DISTINCT FROM p_customer_id)
 OR (v_op.expected_merchant_id IS NOT NULL AND v_op.expected_merchant_id IS DISTINCT FROM p_merchant_id)
 OR (v_op.expected_environment IS NOT NULL AND v_op.expected_environment IS DISTINCT FROM p_environment)
 THEN RETURN jsonb_build_object('ok',false,'code','claim_mismatch'); END IF;
 UPDATE public.booking_card_save_operations SET expected_customer_id=p_customer_id,
   expected_merchant_id=p_merchant_id,expected_environment=p_environment,
   card_dispatch_bound_at=coalesce(card_dispatch_bound_at,transaction_timestamp()) WHERE id=v_op.id;
 RETURN jsonb_build_object('ok',true);
END; $function$
;
REVOKE ALL ON FUNCTION public.bind_booking_existing_card_receipt(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.record_booking_existing_square_card(p_booking_id uuid, p_salon_id uuid, p_customer_id text, p_card_id text, p_merchant_id text, p_environment text, p_brand text, p_last4 text, p_consent_meta jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_booking public.bookings%ROWTYPE; v_cap jsonb; v_op jsonb; v_result jsonb; v_now timestamptz:=transaction_timestamp();
BEGIN
 SELECT * INTO v_booking FROM public.bookings WHERE id=p_booking_id AND salon_id=p_salon_id AND deleted_at IS NULL;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false); END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE WHEN v_booking.group_id IS NULL
   THEN 'booking-management:'||v_booking.id::text ELSE 'booking-management-group:'||v_booking.group_id::text END,0));
 SELECT * INTO v_booking FROM public.bookings WHERE id=p_booking_id AND salon_id=p_salon_id FOR UPDATE;
 IF v_booking.status='cancelled' OR v_booking.start_time_utc<=v_now
   OR coalesce(p_consent_meta->>'receiptSource','')<>'existing_card_read'
   OR coalesce(p_consent_meta->>'feeCents','') !~ '^[0-9]{1,8}$'
   OR coalesce(p_consent_meta->>'policyVersion','') !~ '^nsp_[0-9a-f]{64}$'
   OR EXISTS(SELECT 1 FROM public.booking_card_save_operations WHERE booking_id=p_booking_id AND salon_id=p_salon_id
     AND status IN ('sending','unknown')) THEN RETURN jsonb_build_object('ok',false,'code','reconciliation_required'); END IF;
 IF public.booking_card_protection_state(v_booking)='saved' AND v_booking.noshow_card_id=p_card_id
   AND v_booking.noshow_customer_id=p_customer_id AND v_booking.noshow_consent_meta->>'policyVersion'=p_consent_meta->>'policyVersion' THEN
   RETURN jsonb_build_object('ok',true,'code','saved','idempotent',true); END IF;
 -- An older unproven card is never silently replaced or re-certified.
 IF v_booking.noshow_card_id IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'code','manual_review_required'); END IF;
 IF p_consent_meta->>'source'='prior_matching_consent' AND NOT EXISTS(SELECT 1 FROM public.bookings prior
   WHERE prior.salon_id=p_salon_id AND prior.id<>p_booking_id AND prior.client_phone=v_booking.client_phone
     AND public.booking_card_protection_state(prior)='saved' AND prior.noshow_card_id=p_card_id
     AND prior.noshow_customer_id=p_customer_id AND prior.noshow_consent_meta->>'policyVersion'=p_consent_meta->>'policyVersion') THEN
   RETURN jsonb_build_object('ok',false,'code','fresh_consent_required'); END IF;
 UPDATE public.bookings SET noshow_fee_cents=(p_consent_meta->>'feeCents')::integer WHERE id=p_booking_id;
 v_cap:=public.mint_booking_management_capability(p_salon_id,p_booking_id,'card_manage',v_now+interval '25 minutes');
 IF v_cap->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'existing_card_receipt_unavailable'; END IF;
 v_op:=public.claim_booking_card_save_operation((v_cap->>'token_id')::uuid,extensions.gen_random_uuid(),'square','save_card',
   encode(extensions.digest(convert_to('existing:'||p_card_id||':'||(p_consent_meta->>'policyVersion'),'UTF8'),'sha256'),'hex'));
 IF v_op->>'code' IS DISTINCT FROM 'claimed' OR v_op->>'attempt_replay' IS DISTINCT FROM 'false' THEN
   RAISE EXCEPTION 'existing_card_receipt_unavailable'; END IF;
 v_result:=public.prepare_booking_card_save_dispatch((v_op->>'operation_id')::uuid,(v_op->>'attempt_token')::uuid,v_now,p_consent_meta);
 IF v_result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'existing_card_receipt_unavailable'; END IF;
 v_result:=public.bind_booking_existing_card_receipt((v_op->>'operation_id')::uuid,(v_op->>'attempt_token')::uuid,p_customer_id,p_merchant_id,p_environment);
 IF v_result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'existing_card_receipt_unavailable'; END IF;
 v_result:=public.complete_booking_card_save_operation((v_op->>'operation_id')::uuid,(v_op->>'attempt_token')::uuid,'succeeded',
   p_card_id,p_card_id,p_customer_id,p_brand,p_last4,v_now,p_consent_meta,NULL);
 IF v_result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'existing_card_receipt_unavailable'; END IF;
 UPDATE public.bookings SET deposit_required=false,deposit_status='not_required' WHERE id=p_booking_id AND deposit_status='required';
 RETURN v_result;
END; $function$
;

CREATE OR REPLACE FUNCTION public.bind_booking_card_save_dispatch(p_operation_id uuid, p_attempt_token uuid, p_customer_id text, p_merchant_id text, p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_op public.booking_card_save_operations%ROWTYPE;
BEGIN
 IF p_attempt_token IS NULL OR coalesce(p_customer_id,'') !~ '^[A-Za-z0-9:_-]{1,255}$'
 OR coalesce(p_merchant_id,'') !~ '^[A-Za-z0-9:_-]{1,255}$'
 OR p_environment IS NULL OR p_environment NOT IN ('sandbox','production') THEN
 RETURN jsonb_build_object('ok',false,'code','invalid_binding'); END IF;
 SELECT * INTO v_op FROM public.booking_card_save_operations WHERE id=p_operation_id FOR UPDATE;
 IF NOT FOUND OR v_op.attempt_token IS DISTINCT FROM p_attempt_token OR v_op.status<>'sending'
 OR v_op.dispatch_prepared_at IS NULL OR v_op.created_at < transaction_timestamp()-interval '2 minutes'
 OR (v_op.expected_customer_id IS NOT NULL AND v_op.expected_customer_id IS DISTINCT FROM p_customer_id)
 OR (v_op.expected_merchant_id IS NOT NULL AND v_op.expected_merchant_id IS DISTINCT FROM p_merchant_id)
 OR (v_op.expected_environment IS NOT NULL AND v_op.expected_environment IS DISTINCT FROM p_environment)
 THEN RETURN jsonb_build_object('ok',false,'code','claim_mismatch'); END IF;
 IF v_op.provider='square' AND NOT EXISTS(SELECT 1 FROM public.square_card_customer_claims c
   WHERE c.id=v_op.customer_claim_id AND c.identity_version=2 AND c.identity_authorized
     AND c.identity_rejected_at IS NULL AND c.status='known' AND c.customer_id=p_customer_id
     AND c.salon_id=v_op.salon_id AND c.merchant_id=p_merchant_id AND c.environment=p_environment
     AND c.authority_fingerprint=encode(extensions.digest(convert_to('v2:'||c.authority_kind||':'||
       CASE WHEN c.authority_kind='verified_phone' THEN public.canonical_phone(v_op.provider_material->>'client_phone') ELSE v_op.booking_id::text END,'UTF8'),'sha256'),'hex')
     AND (c.authority_kind='booking' OR public.square_card_booking_phone_authorized(v_op.booking_id,v_op.salon_id,v_op.provider_material))) THEN
   RETURN jsonb_build_object('ok',false,'code','customer_identity_unverified');
 END IF;
 UPDATE public.booking_card_save_operations SET expected_customer_id=p_customer_id,
   expected_merchant_id=p_merchant_id,expected_environment=p_environment,
   card_dispatch_bound_at=coalesce(card_dispatch_bound_at,transaction_timestamp()) WHERE id=v_op.id;
 RETURN jsonb_build_object('ok',true);
END; $function$
;

-- A retired create key must never become a booking, even if its original request arrives late.
-- Keep these minimal tombstones when rolling the application back. No booking is cancelled here.
CREATE TABLE public.retired_booking_create_requests (
  salon_id uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('individual','sequence','group')),
  pricing_fingerprint text NOT NULL CHECK (pricing_fingerprint ~ '^[0-9a-f]{64}$'),
  retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (salon_id, request_id)
);
ALTER TABLE public.retired_booking_create_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.retired_booking_create_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.retired_booking_create_requests TO service_role;
COMMENT ON TABLE public.retired_booking_create_requests IS 'No contact/card data. Durable fencing receipt, not a booking cancellation. No FK cascade or automatic expiry: retain the fence even if its salon is removed.';

CREATE FUNCTION public.guard_retired_booking_create_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.idempotency_key IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key AND NEW.salon_id IS NOT DISTINCT FROM OLD.salon_id THEN RETURN NEW; END IF;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='booking_create_isolation_unsupported';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-create-retirement:'||NEW.salon_id::text||':'||NEW.idempotency_key::text,0));
  IF EXISTS (SELECT 1 FROM public.retired_booking_create_requests r WHERE r.salon_id=NEW.salon_id AND r.request_id=NEW.idempotency_key) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='booking_create_request_retired';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_retired_booking_create_request() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER booking_create_retirement_fence BEFORE INSERT OR UPDATE OF salon_id,idempotency_key ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.guard_retired_booking_create_request();

CREATE FUNCTION public.resolve_pending_booking_create(p_salon_id uuid,p_request_id uuid,p_kind text,p_pricing_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_role text := coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','');
 v_slug text; v_booking public.bookings%ROWTYPE; v_retired public.retired_booking_create_requests%ROWTYPE; v_count integer;
BEGIN
 IF v_role <> 'service_role' THEN RETURN jsonb_build_object('status','unavailable'); END IF;
 IF p_salon_id IS NULL OR p_request_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('individual','sequence','group') OR p_pricing_fingerprint IS NULL OR p_pricing_fingerprint !~ '^[0-9a-f]{64}$' OR current_setting('transaction_isolation') <> 'read committed' THEN RETURN jsonb_build_object('status','unavailable'); END IF;
 SELECT slug INTO v_slug FROM public.salons WHERE id=p_salon_id AND profile_complete;
 IF v_slug IS NULL OR v_slug !~ '^[a-z0-9][a-z0-9-]*$' THEN RETURN jsonb_build_object('status','unavailable'); END IF;
 -- Nonblocking: an in-flight writer remains pending. A read failure is never an empty result.
 IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('booking-create-retirement:'||p_salon_id::text||':'||p_request_id::text,0)) THEN RETURN jsonb_build_object('status','pending'); END IF;
 SELECT count(*) INTO v_count FROM public.bookings WHERE salon_id=p_salon_id AND idempotency_key=p_request_id;
 IF v_count > 0 THEN
   IF v_count <> 1 THEN RETURN jsonb_build_object('status','unavailable'); END IF;
   SELECT * INTO v_booking FROM public.bookings WHERE salon_id=p_salon_id AND idempotency_key=p_request_id;
   IF v_booking.public_booking_pricing_fingerprint IS DISTINCT FROM p_pricing_fingerprint OR
      v_booking.public_booking_pricing_snapshot->>'pricing_fingerprint' IS DISTINCT FROM p_pricing_fingerprint OR
      (CASE WHEN v_booking.group_id IS NOT NULL AND v_booking.is_group_organizer THEN 'group' WHEN v_booking.schedule_model='segments_v1' THEN 'sequence' ELSE 'individual' END) IS DISTINCT FROM p_kind THEN RETURN jsonb_build_object('status','unavailable'); END IF;
   -- Minimal existence proof only, including inactive/expired bookings. Never renew card authority.
   RETURN jsonb_build_object('status','booking_exists','salon_slug',v_slug);
 END IF;
 SELECT * INTO v_retired FROM public.retired_booking_create_requests WHERE salon_id=p_salon_id AND request_id=p_request_id;
 IF FOUND THEN
   IF v_retired.kind IS DISTINCT FROM p_kind OR v_retired.pricing_fingerprint IS DISTINCT FROM p_pricing_fingerprint THEN RETURN jsonb_build_object('status','unavailable'); END IF;
 ELSE
   INSERT INTO public.retired_booking_create_requests(salon_id,request_id,kind,pricing_fingerprint) VALUES(p_salon_id,p_request_id,p_kind,p_pricing_fingerprint);
 END IF;
 RETURN jsonb_build_object('status','retired','salon_slug',v_slug);
END $$;
REVOKE ALL ON FUNCTION public.resolve_pending_booking_create(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_pending_booking_create(uuid,uuid,text,text) TO service_role;

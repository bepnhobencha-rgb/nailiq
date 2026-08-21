\set ON_ERROR_STOP on

DO $check$
DECLARE
  v_resolver regprocedure := pg_catalog.to_regprocedure(
    'public.resolve_group_booking_pricing(uuid,jsonb,uuid,text,text,boolean,boolean)'
  );
  v_quote regprocedure := pg_catalog.to_regprocedure(
    'public.quote_group_booking(uuid,jsonb,uuid,text,text,boolean)'
  );
  v_create regprocedure := pg_catalog.to_regprocedure(
    'public.create_group_bookings(uuid,jsonb,uuid,text,text,boolean,uuid,text)'
  );
  v_legacy regprocedure := pg_catalog.to_regprocedure(
    'public.insert_group_bookings(jsonb)'
  );
  v_target regprocedure;
  v_def text;
BEGIN
  IF v_resolver IS NULL OR v_quote IS NULL OR v_create IS NULL
     OR v_legacy IS NULL THEN
    RAISE EXCEPTION 'group booking pricing signature missing';
  END IF;

  FOREACH v_target IN ARRAY ARRAY[v_resolver, v_quote, v_create]
  LOOP
    IF pg_catalog.has_function_privilege('anon', v_target, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_target, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_target, 'EXECUTE')
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc p
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
         ) acl
         WHERE p.oid = v_target::oid
           AND acl.grantee = 0
           AND acl.privilege_type = 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'group booking pricing ACL mismatch: %', v_target;
    END IF;
    SELECT pg_catalog.pg_get_functiondef(v_target::oid) INTO v_def;
    IF position('SECURITY DEFINER' IN v_def) = 0
       OR position('SET search_path TO ''''' IN v_def) = 0 THEN
      RAISE EXCEPTION 'group booking pricing hardening mismatch: %', v_target;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege('anon', v_legacy, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_legacy, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_legacy, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
       ) acl
       WHERE p.oid = v_legacy::oid
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'legacy insert_group_bookings is not service-only';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_resolver::oid) INTO v_def;
  IF position('public.resolve_public_booking_pricing' IN v_def) = 0
     OR position('FOR UPDATE' IN v_def) = 0
     OR position('largest remainder' IN lower(v_def)) = 0
     OR position('row_number() OVER' IN v_def) = 0
     OR position('v_voucher.free_service_id IS NOT NULL' IN v_def) = 0
     OR position('v_voucher.applicable_service_ids' IN v_def) = 0 THEN
    RAISE EXCEPTION 'group resolver lost an authority/allocation invariant';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_create::oid) INTO v_def;
  IF position('group-booking-idempotency:' IN v_def) = 0
     OR position('public_booking_request_fingerprint' IN v_def) = 0
     OR position('''pricing_changed''' IN v_def) = 0
     OR position('public.resolve_group_booking_pricing' IN v_def) = 0
     OR position('public.booking_addons' IN v_def) = 0
     OR position('public.voucher_redemptions' IN v_def) = 0
     OR position('''monthly_booking_limit_reached''' IN v_def) = 0
     OR position('IF FOUND THEN' IN v_def) >
        position('public.resolve_group_booking_pricing' IN v_def)
     OR position('public.resolve_group_booking_pricing' IN v_def) >
        position('FOR UPDATE' IN v_def) THEN
    RAISE EXCEPTION 'group create lost replay/atomic/quota ordering';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index i
    WHERE i.indexrelid =
        'public.idx_bookings_group_idempotency_once'::regclass
      AND i.indrelid = 'public.bookings'::regclass
      AND i.indisunique AND i.indisvalid
      AND i.indnkeyatts = 2
      AND i.indkey::text = pg_catalog.format(
        '%s %s',
        (SELECT a.attnum FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = 'public.bookings'::regclass
           AND a.attname = 'salon_id'),
        (SELECT a.attnum FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = 'public.bookings'::regclass
           AND a.attname = 'idempotency_key')
      )
      AND pg_catalog.pg_get_expr(i.indpred, i.indrelid) =
        '((idempotency_key IS NOT NULL) AND (group_id IS NOT NULL) AND (is_group_organizer IS TRUE))'
  ) THEN
    RAISE EXCEPTION 'group organizer idempotency index mismatch';
  END IF;

END
$check$;

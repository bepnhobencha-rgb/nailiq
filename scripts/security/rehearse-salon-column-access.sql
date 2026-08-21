\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users(id, email, created_at) VALUES
  ('51100000-0000-4000-8000-000000000001', 'owner-a@nailiq.invalid', now()),
  ('51100000-0000-4000-8000-000000000002', 'admin-a@nailiq.invalid', now()),
  ('51100000-0000-4000-8000-000000000003', 'senior-a@nailiq.invalid', now()),
  ('51100000-0000-4000-8000-000000000004', 'reception-a@nailiq.invalid', now()),
  ('51100000-0000-4000-8000-000000000005', 'tech-a@nailiq.invalid', now()),
  ('51100000-0000-4000-8000-000000000006', 'owner-b@nailiq.invalid', now());

INSERT INTO auth.sessions(id, user_id, created_at, updated_at) VALUES
  ('51100000-0000-4000-8000-000000000011', '51100000-0000-4000-8000-000000000001', now(), now()),
  ('51100000-0000-4000-8000-000000000012', '51100000-0000-4000-8000-000000000002', now(), now()),
  ('51100000-0000-4000-8000-000000000013', '51100000-0000-4000-8000-000000000003', now(), now()),
  ('51100000-0000-4000-8000-000000000014', '51100000-0000-4000-8000-000000000004', now(), now()),
  ('51100000-0000-4000-8000-000000000015', '51100000-0000-4000-8000-000000000005', now(), now()),
  ('51100000-0000-4000-8000-000000000016', '51100000-0000-4000-8000-000000000006', now(), now());

INSERT INTO public.salons(
  id, slug, name, phone, email, timezone, staff_notification_settings,
  client_segment_settings, feature_flags,
  noshow_protection_enabled, winback_enabled,
  stripe_customer_id, admin_notes
) VALUES
  (
    '51100000-0000-4000-8000-000000000021', 'salon-column-a',
    'Salon column A', '+16045550110', 'owner-a@example.test', 'UTC',
    '{
      "enabled": false,
      "defaultLocale": "vi",
      "channels": {"sms": false, "email": true, "recipient": "leak@example.test"},
      "eventDefaults": {"create": false, "cancel": true, "no_show": true},
      "legacy_secret": "must-not-leak"
    }'::jsonb,
    pg_catalog.jsonb_build_object(
      'new_max_visits', pg_catalog.repeat('9', 5000),
      'at_risk_days', 2,
      'legacy_phone', '+16045550999'
    ),
    '{
      "reports_enabled": true,
      "drc_accent_color": "#A1b2C3",
      "drc_bg_color": "not-a-color",
      "legacy_secret": "must-not-leak",
      "unknown_boolean": true,
      "loyalty_enabled": "true"
    }'::jsonb,
    true, false, 'cus_secret_a', 'internal secret a'
  ),
  (
    '51100000-0000-4000-8000-000000000022', 'salon-column-b',
    'Salon column B', '+16045550111', 'owner-b@example.test', 'UTC',
    '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
    false, true, 'cus_secret_b', 'internal secret b'
  );

INSERT INTO public.salon_members(salon_id, user_id, role) VALUES
  ('51100000-0000-4000-8000-000000000021', '51100000-0000-4000-8000-000000000001', 'owner'),
  ('51100000-0000-4000-8000-000000000021', '51100000-0000-4000-8000-000000000002', 'admin'),
  ('51100000-0000-4000-8000-000000000021', '51100000-0000-4000-8000-000000000003', 'senior'),
  ('51100000-0000-4000-8000-000000000021', '51100000-0000-4000-8000-000000000004', 'receptionist'),
  ('51100000-0000-4000-8000-000000000021', '51100000-0000-4000-8000-000000000005', 'nail_tech'),
  ('51100000-0000-4000-8000-000000000022', '51100000-0000-4000-8000-000000000006', 'owner');

SET LOCAL ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim',
  pg_catalog.jsonb_build_object(
    'role', 'authenticated', 'aud', 'authenticated',
    'sub', '51100000-0000-4000-8000-000000000004',
    'session_id', '51100000-0000-4000-8000-000000000014',
    'exp', pg_catalog.floor(extract(epoch FROM now()))::bigint + 600
  )::text,
  true
);
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub', '51100000-0000-4000-8000-000000000004', true
);

DO $$
DECLARE
  v_result jsonb;
  v_count integer;
BEGIN
  SELECT pg_catalog.count(*) INTO v_count
  FROM public.salon_member_operational_profiles;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'receptionist operational view tenant isolation failed: %',
      v_count;
  END IF;

  BEGIN
    PERFORM email FROM public.salons
    WHERE id = '51100000-0000-4000-8000-000000000021';
    RAISE EXCEPTION 'receptionist directly read salon email';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM feature_flags FROM public.salons
    WHERE id = '51100000-0000-4000-8000-000000000021';
    RAISE EXCEPTION 'receptionist directly read raw salon feature flags';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM staff_notification_settings FROM public.salons
    WHERE id = '51100000-0000-4000-8000-000000000021';
    RAISE EXCEPTION 'receptionist directly read raw staff notification JSON';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  v_result := public.load_salon_member_operational_profile(
    '51100000-0000-4000-8000-000000000021'
  );
  IF v_result->>'code' <> 'loaded'
     OR v_result->>'role' <> 'receptionist'
     OR v_result#>>'{salon,staff_notification_settings,enabled}' <> 'false'
     OR v_result#>>'{salon,staff_notification_settings,channels,sms}' <> 'false'
     OR v_result#>>'{salon,staff_notification_settings,eventDefaults,no_show}' <> 'true'
     OR v_result#>>'{salon,client_segment_settings,new_max_visits}' <> '1'
     OR v_result#>>'{salon,client_segment_settings,at_risk_days}' <> '7'
     OR v_result#>>'{salon,feature_flags,reports_enabled}' <> 'true'
     OR v_result#>>'{salon,feature_flags,drc_accent_color}' <> '#A1b2C3'
     OR v_result#>'{salon,feature_flags}' ? 'drc_bg_color'
     OR v_result#>'{salon,feature_flags}' ? 'legacy_secret'
     OR v_result#>'{salon,feature_flags}' ? 'unknown_boolean'
     OR v_result#>'{salon,feature_flags}' ? 'loyalty_enabled'
     OR v_result#>'{salon,staff_notification_settings}' ? 'legacy_secret'
     OR v_result#>'{salon,staff_notification_settings,channels}' ? 'recipient'
     OR v_result#>'{salon,client_segment_settings}' ? 'legacy_phone'
     OR v_result#>'{salon}' ? 'email'
     OR v_result#>'{salon}' ? 'stripe_customer_id'
  THEN
    RAISE EXCEPTION 'member operational profile was not normalized/safe: %',
      v_result;
  END IF;

  v_result := public.load_salon_owner_admin_settings(
    '51100000-0000-4000-8000-000000000021'
  );
  IF v_result->>'code' <> 'forbidden' THEN
    RAISE EXCEPTION 'receptionist loaded owner/admin settings: %', v_result;
  END IF;

  v_result := public.load_salon_member_operational_profile(
    '51100000-0000-4000-8000-000000000022'
  );
  IF v_result->>'code' <> 'forbidden' THEN
    RAISE EXCEPTION 'receptionist crossed tenant through member loader: %',
      v_result;
  END IF;
END $$;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim',
  pg_catalog.jsonb_build_object(
    'role', 'authenticated', 'aud', 'authenticated',
    'sub', '51100000-0000-4000-8000-000000000003',
    'session_id', '51100000-0000-4000-8000-000000000013',
    'exp', pg_catalog.floor(extract(epoch FROM now()))::bigint + 600
  )::text,
  true
);
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub', '51100000-0000-4000-8000-000000000003', true
);
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.load_salon_member_operational_profile(
    '51100000-0000-4000-8000-000000000021'
  );
  IF v_result->>'code' <> 'loaded' OR v_result->>'role' <> 'senior' THEN
    RAISE EXCEPTION 'senior operational loader mismatch: %', v_result;
  END IF;
  IF public.load_salon_owner_admin_settings(
    '51100000-0000-4000-8000-000000000021'
  )->>'code' <> 'forbidden' THEN
    RAISE EXCEPTION 'senior loaded management settings';
  END IF;
END $$;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim',
  pg_catalog.jsonb_build_object(
    'role', 'authenticated', 'aud', 'authenticated',
    'sub', '51100000-0000-4000-8000-000000000005',
    'session_id', '51100000-0000-4000-8000-000000000015',
    'exp', pg_catalog.floor(extract(epoch FROM now()))::bigint + 600
  )::text,
  true
);
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub', '51100000-0000-4000-8000-000000000005', true
);
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.load_salon_member_operational_profile(
    '51100000-0000-4000-8000-000000000021'
  );
  IF v_result->>'code' <> 'loaded' OR v_result->>'role' <> 'nail_tech' THEN
    RAISE EXCEPTION 'nail-tech operational loader mismatch: %', v_result;
  END IF;
  IF public.load_salon_owner_admin_settings(
    '51100000-0000-4000-8000-000000000021'
  )->>'code' <> 'forbidden' THEN
    RAISE EXCEPTION 'nail-tech loaded management settings';
  END IF;
END $$;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim',
  pg_catalog.jsonb_build_object(
    'role', 'authenticated', 'aud', 'authenticated',
    'sub', '51100000-0000-4000-8000-000000000001',
    'session_id', '51100000-0000-4000-8000-000000000011',
    'exp', pg_catalog.floor(extract(epoch FROM now()))::bigint + 600
  )::text,
  true
);
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub', '51100000-0000-4000-8000-000000000001', true
);
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.load_salon_owner_admin_settings(
    '51100000-0000-4000-8000-000000000021'
  );
  IF v_result->>'code' <> 'loaded'
     OR v_result->>'role' <> 'owner'
     OR v_result#>>'{settings,email}' <> 'owner-a@example.test'
     OR v_result#>'{settings}' ? 'stripe_customer_id'
     OR v_result#>'{settings}' ? 'admin_notes'
     OR v_result#>'{settings}' ? 'phone'
  THEN
    RAISE EXCEPTION 'owner settings loader mismatch: %', v_result;
  END IF;
END $$;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim',
  pg_catalog.jsonb_build_object(
    'role', 'authenticated', 'aud', 'authenticated',
    'sub', '51100000-0000-4000-8000-000000000002',
    'session_id', '51100000-0000-4000-8000-000000000012',
    'exp', pg_catalog.floor(extract(epoch FROM now()))::bigint + 600
  )::text,
  true
);
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub', '51100000-0000-4000-8000-000000000002', true
);
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.load_salon_owner_admin_settings(
    '51100000-0000-4000-8000-000000000021'
  );
  IF v_result->>'code' <> 'loaded' OR v_result->>'role' <> 'admin' THEN
    RAISE EXCEPTION 'admin settings loader mismatch: %', v_result;
  END IF;
END $$;

RESET ROLE;
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.salon_member_operational_profiles;
    RAISE EXCEPTION 'anon read authenticated operational view';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM email FROM public.salons LIMIT 1;
    RAISE EXCEPTION 'anon read salon email';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM public.load_salon_member_operational_profile(
      '51100000-0000-4000-8000-000000000021'
    );
    RAISE EXCEPTION 'anon executed member loader';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;

RESET ROLE;
SET LOCAL ROLE service_role;
DO $$
DECLARE v_email text;
BEGIN
  SELECT email INTO v_email
  FROM public.salons
  WHERE id = '51100000-0000-4000-8000-000000000021';
  IF v_email <> 'owner-a@example.test' THEN
    RAISE EXCEPTION 'service role lost authoritative salon access';
  END IF;
END $$;

ROLLBACK;
SELECT 'salon column access behavior passed' AS result;

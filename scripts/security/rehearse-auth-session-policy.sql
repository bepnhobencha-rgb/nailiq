\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users(
  id, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at
) VALUES (
  '51340000-0000-4000-8000-000000000001',
  'auth-session-qa@nailiq.invalid', '', transaction_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, transaction_timestamp()
);

INSERT INTO auth.sessions(id, user_id, created_at, updated_at)
VALUES (
  '51340000-0000-4000-8000-000000000002',
  '51340000-0000-4000-8000-000000000001',
  transaction_timestamp(), transaction_timestamp()
);

SET LOCAL ROLE authenticated;

SELECT set_config(
  'request.jwt.claim',
  jsonb_build_object(
    'role', 'authenticated',
    'aud', 'authenticated',
    'sub', '51340000-0000-4000-8000-000000000001',
    'session_id', '51340000-0000-4000-8000-000000000002',
    'exp', floor(extract(epoch FROM statement_timestamp()))::bigint + 600
  )::text,
  true
);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', '51340000-0000-4000-8000-000000000001', true);
DO $$ BEGIN
  IF NOT public.current_auth_session_is_active() THEN
    RAISE EXCEPTION 'live session rejected';
  END IF;
END $$;

SELECT set_config(
  'request.jwt.claim',
  jsonb_build_object(
    'role', 'authenticated', 'aud', 'authenticated',
    'sub', '51340000-0000-4000-8000-000000000001',
    'session_id', '51340000-0000-4000-8000-000000000002',
    'exp', floor(extract(epoch FROM statement_timestamp()))::bigint - 1
  )::text, true
);
DO $$ BEGIN
  IF public.current_auth_session_is_active() THEN RAISE EXCEPTION 'expired JWT accepted'; END IF;
END $$;

SELECT set_config(
  'request.jwt.claim',
  jsonb_build_object(
    'role', 'authenticated', 'aud', 'wrong-audience',
    'sub', '51340000-0000-4000-8000-000000000001',
    'session_id', '51340000-0000-4000-8000-000000000002',
    'exp', floor(extract(epoch FROM statement_timestamp()))::bigint + 600
  )::text, true
);
DO $$ BEGIN
  IF public.current_auth_session_is_active() THEN RAISE EXCEPTION 'wrong audience accepted'; END IF;
END $$;

SELECT set_config(
  'request.jwt.claim',
  jsonb_build_object(
    'role', 'authenticated', 'aud', 'authenticated',
    'sub', '51340000-0000-4000-8000-000000000001',
    'session_id', 'malformed',
    'exp', floor(extract(epoch FROM statement_timestamp()))::bigint + 600
  )::text, true
);
DO $$ BEGIN
  IF public.current_auth_session_is_active() THEN RAISE EXCEPTION 'malformed session id accepted'; END IF;
END $$;

SELECT set_config(
  'request.jwt.claim',
  jsonb_build_object(
    'role', 'authenticated', 'aud', 'authenticated',
    'sub', '51340000-0000-4000-8000-000000000001',
    'session_id', '51340000-0000-4000-8000-000000000002',
    'is_anonymous', true,
    'exp', floor(extract(epoch FROM statement_timestamp()))::bigint + 600
  )::text, true
);
DO $$ BEGIN
  IF public.current_auth_session_is_active() THEN RAISE EXCEPTION 'anonymous Auth session accepted'; END IF;
END $$;

RESET ROLE;
DELETE FROM auth.sessions WHERE id = '51340000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim',
  jsonb_build_object(
    'role', 'authenticated', 'aud', 'authenticated',
    'sub', '51340000-0000-4000-8000-000000000001',
    'session_id', '51340000-0000-4000-8000-000000000002',
    'exp', floor(extract(epoch FROM statement_timestamp()))::bigint + 600
  )::text, true
);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', '51340000-0000-4000-8000-000000000001', true);
DO $$ BEGIN
  IF public.current_auth_session_is_active() THEN RAISE EXCEPTION 'revoked session accepted'; END IF;
END $$;

ROLLBACK;
SELECT 'auth session behavior passed' AS result;

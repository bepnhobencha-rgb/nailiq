\set ON_ERROR_STOP on

DO $$
DECLARE
  v_rows bigint;
  v_secret_configured boolean;
BEGIN
  IF current_setting('server_version_num')::integer < 150000 THEN
    RAISE EXCEPTION 'PostgreSQL 15+ required';
  END IF;
  IF to_regprocedure('extensions.hmac(bytea,bytea,text)') IS NULL
     OR to_regprocedure('extensions.digest(bytea,text)') IS NULL
  THEN RAISE EXCEPTION 'pgcrypto digest/hmac functions unavailable';
  END IF;
  IF to_regprocedure('public.canonical_phone(text)') IS NULL THEN
    RAISE EXCEPTION 'canonical phone function unavailable';
  END IF;

  SELECT count(*) INTO v_rows FROM public.sms_consent_events;
  IF v_rows <> 0 THEN
    RAISE NOTICE 'existing SMS consent event rows: %', v_rows;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.platform_settings ps
    WHERE ps.id = 'platform'
      AND ps.sms_consent_hash_secret IS NOT NULL
      AND ps.sms_consent_hash_key_id IS NOT NULL
      AND length(ps.sms_consent_hash_secret) BETWEEN 32 AND 512
  ) INTO v_secret_configured;
  RAISE NOTICE 'sms consent HMAC configured (value never printed): %',
    v_secret_configured;

  IF EXISTS (
    SELECT 1 FROM public.sms_consent_events
    WHERE phone_hash !~ '^[0-9a-f]{64}$'
       OR material_fingerprint !~ '^[0-9a-f]{64}$'
  ) THEN RAISE EXCEPTION 'malformed existing SMS consent fingerprints';
  END IF;
END;
$$;

SELECT
  (SELECT count(*) FROM public.sms_consent_events) AS event_rows,
  pg_size_pretty(pg_total_relation_size('public.sms_consent_events'))
    AS event_table_size,
  (SELECT count(*) FROM public.sms_consent_provider_states)
    AS provider_state_rows,
  (SELECT count(*) FROM public.sms_consent_salon_states)
    AS salon_state_rows;

SELECT 'sms consent suppression preflight passed' AS result;

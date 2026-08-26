\set ON_ERROR_STOP on
BEGIN;

DROP FUNCTION public.load_sms_outbound_suppression(uuid, text, uuid);
DROP FUNCTION public.inspect_sms_consent_event(uuid);
DROP FUNCTION public.record_sms_consent_event(uuid, uuid, text);
DROP FUNCTION public.claim_sms_consent_event(
  uuid, text, text, text, uuid, text, uuid, text, text,
  text, text, timestamptz
);
DROP FUNCTION public.hash_sms_consent_phone(text);
DROP FUNCTION public.sms_consent_provider_context();
DROP TABLE public.sms_consent_salon_states;
DROP TABLE public.sms_consent_provider_states;
DROP TABLE public.sms_consent_events;
ALTER TABLE public.platform_settings
  DROP CONSTRAINT platform_settings_sms_consent_hash_key_check,
  DROP COLUMN sms_consent_hash_secret,
  DROP COLUMN sms_consent_hash_key_id;
GRANT ALL ON TABLE public.platform_settings TO anon, authenticated;

DO $$
BEGIN
  IF to_regclass('public.sms_consent_events') IS NOT NULL
     OR to_regprocedure('public.load_sms_outbound_suppression(uuid,text,uuid)')
        IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'platform_settings'
         AND column_name = 'sms_consent_hash_secret'
     )
     OR NOT has_table_privilege('anon', 'public.platform_settings', 'SELECT')
     OR NOT has_table_privilege(
       'authenticated', 'public.platform_settings', 'SELECT'
     )
  THEN RAISE EXCEPTION 'SMS consent down rehearsal left new contract behind';
  END IF;
END;
$$;

ROLLBACK;

DO $$
BEGIN
  IF to_regclass('public.sms_consent_events') IS NULL
     OR to_regprocedure('public.load_sms_outbound_suppression(uuid,text,uuid)')
        IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'platform_settings'
         AND column_name = 'sms_consent_hash_secret'
     )
  THEN RAISE EXCEPTION 'rollback did not restore SMS consent contract';
  END IF;
END;
$$;

SELECT 'sms consent suppression rollback passed' AS result;

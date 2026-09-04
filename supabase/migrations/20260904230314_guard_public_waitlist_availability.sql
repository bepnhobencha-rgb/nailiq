-- False Waitlist safety boundary.
--
-- Public browsers may no longer invoke the write RPC directly. The same-origin
-- Next route performs proof-grade availability revalidation first, then calls
-- this RPC with service_role. This keeps transport/RPC failures from being
-- interpreted as "full" while preserving the RPC's existing idempotency key.
--
-- Rollback: restore EXECUTE to anon only together with reverting the client to
-- the previous direct-RPC path. Dropping the trigger is safe but would collapse
-- source provenance back to the legacy hard-coded value.

ALTER TABLE public.booking_waitlist_entries
  DROP CONSTRAINT IF EXISTS booking_waitlist_entries_source_check;

ALTER TABLE public.booking_waitlist_entries
  ADD CONSTRAINT booking_waitlist_entries_source_check
  CHECK (
    source = ANY (
      ARRAY[
        'slot_unavailable'::text,
        'booking_conflict'::text
      ]
    )
  ) NOT VALID;

ALTER TABLE public.booking_waitlist_entries
  VALIDATE CONSTRAINT booking_waitlist_entries_source_check;

CREATE OR REPLACE FUNCTION public.normalize_capacity_rescue_waitlist_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_source text;
BEGIN
  IF NEW.request_kind <> 'individual' THEN
    RETURN NEW;
  END IF;

  -- New requests carry source in intent_json so the legacy RPC's hard-coded
  -- column value cannot erase booking_conflict provenance. Existing trusted
  -- server callers may not have intent_json.source yet; preserve their valid
  -- row source during the compatibility window.
  v_source := COALESCE(
    NULLIF(pg_catalog.btrim(NEW.intent_json ->> 'source'), ''),
    NULLIF(pg_catalog.btrim(NEW.source), '')
  );
  IF v_source IS NULL OR v_source NOT IN (
    'slot_unavailable',
    'booking_conflict'
  ) THEN
    RAISE EXCEPTION 'invalid_waitlist_source' USING ERRCODE = '22023';
  END IF;

  NEW.source := v_source;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.normalize_capacity_rescue_waitlist_source()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS normalize_capacity_rescue_waitlist_source_trigger
  ON public.booking_waitlist_entries;
CREATE TRIGGER normalize_capacity_rescue_waitlist_source_trigger
BEFORE INSERT ON public.booking_waitlist_entries
FOR EACH ROW
EXECUTE FUNCTION public.normalize_capacity_rescue_waitlist_source();

REVOKE ALL ON FUNCTION public.create_public_capacity_rescue_request(
  uuid, uuid, text, uuid, uuid, date, text, integer,
  text, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_capacity_rescue_request(
  uuid, uuid, text, uuid, uuid, date, text, integer,
  text, text, text, text, jsonb
) TO service_role;

-- The legacy individual RPC is now server-only as well. Voice AI is its only
-- remaining application caller and already uses service_role.
REVOKE ALL ON FUNCTION public.create_public_waitlist_entry(
  uuid, uuid, uuid, date, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_waitlist_entry(
  uuid, uuid, uuid, date, text, text, text, text, text
) TO service_role;

DO $verify$
BEGIN
  IF pg_catalog.has_function_privilege(
    'anon',
    'public.create_public_capacity_rescue_request(uuid,uuid,text,uuid,uuid,date,text,integer,text,text,text,text,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon capacity rescue privilege was not revoked';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.create_public_capacity_rescue_request(uuid,uuid,text,uuid,uuid,date,text,integer,text,text,text,text,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role capacity rescue privilege is missing';
  END IF;
  IF pg_catalog.has_function_privilege(
    'anon',
    'public.create_public_waitlist_entry(uuid,uuid,uuid,date,text,text,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon legacy waitlist privilege was not revoked';
  END IF;
END;
$verify$;

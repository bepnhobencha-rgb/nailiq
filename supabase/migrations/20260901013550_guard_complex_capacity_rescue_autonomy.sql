-- Complex capacity-rescue requests cannot truthfully use the legacy
-- individual one-slot offer lifecycle. Quarantine any legacy drift first,
-- then keep the invariant at the database boundary for every caller.

UPDATE public.waitlist_claim_capabilities AS capability
SET revoked_at = coalesce(capability.revoked_at, pg_catalog.transaction_timestamp()),
    updated_at = pg_catalog.transaction_timestamp()
WHERE capability.waitlist_entry_id IN (
  SELECT entry.id
  FROM public.booking_waitlist_entries AS entry
  WHERE entry.request_kind IN ('group', 'sequence')
    AND entry.status IN ('waiting', 'notified')
);

UPDATE public.waitlist_offer_delivery_outbox AS delivery
SET status = CASE
      WHEN delivery.status = 'sending' THEN 'unknown'
      ELSE 'suppressed'
    END,
    error_code = CASE
      WHEN delivery.status = 'sending'
        THEN 'complex_offer_delivery_ambiguous'
      ELSE 'complex_request_requires_plan'
    END,
    completed_at = pg_catalog.transaction_timestamp(),
    updated_at = pg_catalog.transaction_timestamp()
WHERE delivery.waitlist_entry_id IN (
  SELECT entry.id
  FROM public.booking_waitlist_entries AS entry
  WHERE entry.request_kind IN ('group', 'sequence')
    AND entry.status IN ('waiting', 'notified')
)
  AND delivery.status IN ('pending', 'sending');

UPDATE public.booking_waitlist_entries
SET status = 'review_required',
    notified_at = NULL,
    claim_token = NULL,
    offered_staff_id = NULL,
    offered_start_utc = NULL,
    offered_end_utc = NULL
WHERE request_kind IN ('group', 'sequence')
  AND status IN ('waiting', 'notified');

CREATE OR REPLACE FUNCTION public.guard_complex_capacity_rescue_autonomy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.request_kind IN ('group', 'sequence')
     AND NEW.status IN ('waiting', 'notified') THEN
    RAISE EXCEPTION 'complex_request_requires_plan'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_complex_capacity_rescue_autonomy
  ON public.booking_waitlist_entries;

CREATE TRIGGER guard_complex_capacity_rescue_autonomy
BEFORE INSERT OR UPDATE OF request_kind, status
ON public.booking_waitlist_entries
FOR EACH ROW
EXECUTE FUNCTION public.guard_complex_capacity_rescue_autonomy();

REVOKE ALL ON FUNCTION public.guard_complex_capacity_rescue_autonomy()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_complex_capacity_rescue_autonomy()
  TO service_role;

COMMENT ON FUNCTION public.guard_complex_capacity_rescue_autonomy() IS
  'Fail-closed boundary: group/sequence rescue requires an executable plan and cannot enter the individual waiting/notified worker.';

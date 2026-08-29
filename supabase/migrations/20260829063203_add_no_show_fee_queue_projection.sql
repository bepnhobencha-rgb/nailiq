-- Keep booking_no_show_decisions service-only and non-queryable while exposing
-- the minimum committed-decision projection needed by the Owner/Admin fee queue.
-- The UI must not receive attendance effects, actor identity, or lease state.

CREATE OR REPLACE FUNCTION public.list_booking_no_show_fee_queue_decisions(
  p_salon_id uuid
)
RETURNS TABLE (
  id uuid,
  booking_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  IF p_salon_id IS NULL OR (
    v_request_role <> 'service_role'
    AND session_user NOT IN ('postgres', 'supabase_admin')
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT d.id, d.booking_id
  FROM public.booking_no_show_decisions AS d
  WHERE d.salon_id = p_salon_id
    AND d.state = 'committed'
  ORDER BY d.committed_at DESC NULLS LAST, d.id DESC
  LIMIT 100;
END
$function$;

REVOKE ALL ON FUNCTION public.list_booking_no_show_fee_queue_decisions(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_booking_no_show_fee_queue_decisions(uuid)
  TO service_role;

COMMENT ON FUNCTION public.list_booking_no_show_fee_queue_decisions(uuid) IS
  'Service-only, salon-scoped projection for the Owner/Admin no-show fee queue. Returns only committed decision and booking ids.';

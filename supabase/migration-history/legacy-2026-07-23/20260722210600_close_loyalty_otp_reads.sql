-- Loyalty phone numbers and OTP sessions are capabilities, not public catalog
-- data. Filtering a public table query by phone/session in the browser does not
-- prevent enumeration or reuse by another caller.

DROP POLICY IF EXISTS "public read own card by phone" ON public.loyalty_cards;
REVOKE SELECT ON TABLE public.loyalty_cards FROM anon;

CREATE FUNCTION public.validate_phone_otp_session(
  p_session_id uuid,
  p_salon_id uuid,
  p_phone text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.phone_otp_sessions s
    WHERE s.id = p_session_id
      AND s.salon_id = p_salon_id
      AND s.phone = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
      AND s.consumed_at IS NULL
      AND s.expires_at > now()
  );
$function$;

REVOKE ALL ON FUNCTION public.validate_phone_otp_session(uuid, uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_phone_otp_session(uuid, uuid, text)
  TO anon, authenticated, service_role;

DROP POLICY IF EXISTS anon_read_valid_otp_session ON public.phone_otp_sessions;
REVOKE SELECT ON TABLE public.phone_otp_sessions FROM anon;

COMMENT ON FUNCTION public.validate_phone_otp_session(uuid, uuid, text) IS
  'Boolean capability check for an exact OTP session, salon and phone; never exposes session rows.';

-- Reverse a no-show bump (when a no-show is undone — e.g. the customer was just
-- running late). Floors at 0. SECURITY DEFINER mirrors bump_client_no_show.
CREATE OR REPLACE FUNCTION public.unbump_client_no_show(p_phone text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.client_profiles
     SET no_show_count = GREATEST(coalesce(no_show_count, 0) - 1, 0),
         updated_at = now()
   WHERE phone = p_phone;
$$;

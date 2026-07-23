-- Itemized add-ons per booking (a booking can have several). The booking row's
-- addon_price_cents still holds the SUM for fast totals; this table is the
-- itemized list for dashboards/receipts.
CREATE TABLE IF NOT EXISTS public.booking_addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  service_id uuid REFERENCES public.services(id),
  name text NOT NULL,
  price_cents int,
  duration_minutes int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_addons_booking ON public.booking_addons(booking_id);

ALTER TABLE public.booking_addons ENABLE ROW LEVEL SECURITY;
-- No anon policies: writes go through the SECURITY DEFINER RPC below; reads use
-- the dashboard service-role client. (Matches how bookings itself is written.)

-- Attach add-ons to a freshly-created booking. SECURITY DEFINER so the public
-- (anon) booking flow can call it; prices/durations/names are taken from the
-- services table server-side (never trusted from the client), and each service
-- must belong to the booking's salon and be flagged is_addon.
CREATE OR REPLACE FUNCTION public.add_booking_addons(
  p_booking_id uuid,
  p_service_ids uuid[]
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_salon_id uuid;
  v_count int := 0;
BEGIN
  SELECT salon_id INTO v_salon_id FROM public.bookings WHERE id = p_booking_id;
  IF v_salon_id IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO public.booking_addons (booking_id, service_id, name, price_cents, duration_minutes)
  SELECT p_booking_id, s.id, s.name, s.price_cents,
         COALESCE(s.duration_minutes, 0) + COALESCE(s.buffer_minutes, 0)
  FROM public.services s
  JOIN unnest(p_service_ids) WITH ORDINALITY AS req(service_id, ord)
    ON req.service_id = s.id
  WHERE s.salon_id = v_salon_id
    AND s.is_addon = true
    AND s.deleted_at IS NULL
  ORDER BY req.ord;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_booking_addons(uuid, uuid[]) TO anon, authenticated;

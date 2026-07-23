-- Per-salon opt-in: auto-mark a booking no_show when it's this many minutes past
-- its START and still 'confirmed' (never checked-in / started). NULL or 0 = off.
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS auto_no_show_minutes integer
    CHECK (auto_no_show_minutes IS NULL OR (auto_no_show_minutes >= 0 AND auto_no_show_minutes <= 240));

COMMENT ON COLUMN public.salons.auto_no_show_minutes IS
  'Opt-in auto no-show: minutes past start before a still-confirmed booking is auto-marked no_show. NULL/0 = disabled.';

CREATE OR REPLACE FUNCTION public.auto_mark_no_shows()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  WITH marked AS (
    UPDATE public.bookings b
       SET status = 'no_show', updated_at = now()
      FROM public.salons s
     WHERE b.salon_id = s.id
       AND s.auto_no_show_minutes IS NOT NULL
       AND s.auto_no_show_minutes > 0
       AND b.status = 'confirmed'
       AND b.start_time_utc < now() - (s.auto_no_show_minutes || ' minutes')::interval
    RETURNING b.client_phone
  ),
  counts AS (
    SELECT client_phone, count(*)::int AS n
    FROM marked
    WHERE client_phone IS NOT NULL AND btrim(client_phone) <> ''
    GROUP BY client_phone
  ),
  bumped AS (
    UPDATE public.client_profiles cp
       SET no_show_count = coalesce(cp.no_show_count, 0) + c.n,
           updated_at = now()
      FROM counts c
     WHERE cp.phone = c.client_phone
    RETURNING 1
  )
  SELECT coalesce((SELECT count(*) FROM marked), 0) INTO v_count;
  RETURN v_count;
END;
$$;

SELECT cron.schedule('auto-mark-no-shows', '*/10 * * * *', 'select public.auto_mark_no_shows()');

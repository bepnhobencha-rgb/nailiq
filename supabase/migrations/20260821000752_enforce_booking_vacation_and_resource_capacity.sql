-- MQA-0049/0055/0056/0057: make staff vacation and the optional physical
-- resource dimension authoritative at the database write boundary.
--
-- Public slot discovery remains useful UX, but it cannot be the final guard:
-- group/desk/voice/service-role writers and response races can bypass a prior
-- availability read.  This trigger covers both legacy single bookings and
-- every occupied segment in segments_v1.  Phase-1 resources are exclusive
-- physical capacity (station/chair/bed/backwash/room/other); multi-seat room
-- capacity is intentionally not invented here.

CREATE OR REPLACE FUNCTION public.enforce_booking_operational_capacity_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_salon_id uuid;
  v_staff_id uuid;
  v_resource_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_live boolean;
  v_timezone text;
  v_resources_enabled boolean;
  v_local_start_date date;
  v_local_end_date date;
BEGIN
  IF TG_TABLE_NAME = 'bookings' THEN
    v_salon_id := NEW.salon_id;
    v_staff_id := NEW.staff_id;
    v_resource_id := NEW.resource_id;
    v_start := NEW.start_time_utc;
    v_end := NEW.end_time_utc;
    v_live := NEW.deleted_at IS NULL
      AND NEW.status NOT IN ('cancelled', 'no_show', 'completed');
  ELSIF TG_TABLE_NAME = 'booking_service_segments' THEN
    v_salon_id := NEW.salon_id;
    v_staff_id := NEW.staff_id;
    v_resource_id := NEW.resource_id;
    v_start := NEW.occupied_start_utc;
    v_end := NEW.occupied_end_utc;
    v_live := NEW.reservation_status NOT IN (
      'cancelled', 'no_show', 'completed'
    );
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'unsupported capacity guard table';
  END IF;

  IF NOT v_live THEN
    RETURN NEW;
  END IF;
  IF v_salon_id IS NULL OR v_staff_id IS NULL
     OR v_start IS NULL OR v_end IS NULL OR v_start >= v_end THEN
    RETURN NEW; -- Existing NOT NULL/time-shape constraints own this failure.
  END IF;

  SELECT nullif(pg_catalog.btrim(s.timezone), ''), s.resources_enabled
  INTO v_timezone, v_resources_enabled
  FROM public.salons AS s
  WHERE s.id = v_salon_id;
  IF NOT FOUND OR v_timezone IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names AS tz
    WHERE tz.name = v_timezone
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023', MESSAGE = 'salon timezone unavailable';
  END IF;

  v_local_start_date := (v_start AT TIME ZONE v_timezone)::date;
  v_local_end_date := (
    (v_end - interval '1 microsecond') AT TIME ZONE v_timezone
  )::date;

  IF EXISTS (
    SELECT 1
    FROM public.staff_unavailability AS su
    WHERE su.salon_id = v_salon_id
      AND su.staff_id = v_staff_id
      AND su.date BETWEEN v_local_start_date AND v_local_end_date
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01', MESSAGE = 'staff unavailable';
  END IF;

  IF v_resources_enabled IS TRUE THEN
    IF v_resource_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.salon_resources AS r
      WHERE r.id = v_resource_id
        AND r.salon_id = v_salon_id
        AND r.status = 'active'
        AND r.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23P01', MESSAGE = 'active resource required';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_booking_operational_capacity_guard
  ON public.bookings;
CREATE TRIGGER enforce_booking_operational_capacity_guard
  BEFORE INSERT OR UPDATE OF
    salon_id, staff_id, resource_id, start_time_utc, end_time_utc,
    status, deleted_at, schedule_model
  ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_booking_operational_capacity_guard();

DROP TRIGGER IF EXISTS enforce_segment_operational_capacity_guard
  ON public.booking_service_segments;
CREATE TRIGGER enforce_segment_operational_capacity_guard
  BEFORE INSERT OR UPDATE OF
    salon_id, staff_id, resource_id, occupied_start_utc, occupied_end_utc,
    reservation_status
  ON public.booking_service_segments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_booking_operational_capacity_guard();

REVOKE ALL ON FUNCTION public.enforce_booking_operational_capacity_guard()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_booking_operational_capacity_guard() IS
  'Fail-closed write guard for local-date staff vacation and exclusive active physical resources across single bookings and sequence segments.';

DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.bookings'::regclass
      AND tgname = 'enforce_booking_operational_capacity_guard'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.booking_service_segments'::regclass
      AND tgname = 'enforce_segment_operational_capacity_guard'
      AND NOT tgisinternal
  ) OR pg_catalog.has_function_privilege(
    'anon', 'public.enforce_booking_operational_capacity_guard()', 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.enforce_booking_operational_capacity_guard()', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'operational capacity guard boundary mismatch';
  END IF;
END
$proof$;

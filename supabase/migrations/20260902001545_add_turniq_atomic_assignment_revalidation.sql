-- TurnIQ M3D: atomic confirmation safety.
--
-- The recommendation engine intentionally remains pure and read-only. This
-- migration adds the database backstop required before a desk user may confirm
-- or override a recommendation: the chosen technician, appointment gap and
-- resource are revalidated in the same transaction that assigns the booking.
-- It is inert unless an active TurnIQ recommendation exists for the booking.
--
-- Rollback boundary: keep turniq_trust_engine_enabled OFF, remove the TurnIQ
-- trigger/function, and restore the two resource guard functions from their
-- source migrations. Existing ledger evidence must not be deleted.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Service resource mode `none` was introduced after the generic auto allocator.
-- Make the allocator honor that service truth instead of allocating a resource
-- that the later requirement trigger immediately clears.
CREATE OR REPLACE FUNCTION public.auto_assign_single_booking_resource()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_resources_enabled boolean;
  v_resource_requirement_mode text := 'salon_default';
  v_resource_id uuid;
BEGIN
  IF NEW.schedule_model <> 'single'
     OR NEW.deleted_at IS NOT NULL
     OR NEW.status IN ('cancelled', 'no_show', 'completed')
     OR NEW.resource_id IS NOT NULL
     OR NEW.salon_id IS NULL
     OR NEW.service_id IS NULL
     OR NEW.start_time_utc IS NULL
     OR NEW.end_time_utc IS NULL
     OR NEW.start_time_utc >= NEW.end_time_utc THEN
    RETURN NEW;
  END IF;

  SELECT s.resources_enabled, svc.resource_requirement_mode
  INTO v_resources_enabled, v_resource_requirement_mode
  FROM public.salons AS s
  JOIN public.services AS svc
    ON svc.id = NEW.service_id
   AND svc.salon_id = s.id
   AND svc.deleted_at IS NULL
  WHERE s.id = NEW.salon_id;

  IF NOT FOUND OR v_resources_enabled IS NOT TRUE
     OR v_resource_requirement_mode = 'none' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'booking-capacity:resource-auto:' || NEW.salon_id::text,
      0
    )
  );

  SELECT r.id
  INTO v_resource_id
  FROM public.salon_resources AS r
  WHERE r.salon_id = NEW.salon_id
    AND r.status = 'active'
    AND r.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.bookings AS b
      WHERE b.salon_id = NEW.salon_id
        AND b.id IS DISTINCT FROM NEW.id
        AND b.resource_id = r.id
        AND b.deleted_at IS NULL
        AND b.status NOT IN ('cancelled', 'no_show', 'completed')
        AND pg_catalog.tstzrange(
          b.start_time_utc, b.end_time_utc, '[)'
        ) && pg_catalog.tstzrange(
          NEW.start_time_utc, NEW.end_time_utc, '[)'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.booking_service_segments AS seg
      WHERE seg.salon_id = NEW.salon_id
        AND seg.resource_id = r.id
        AND seg.reservation_status NOT IN (
          'cancelled', 'no_show', 'completed'
        )
        AND pg_catalog.tstzrange(
          seg.occupied_start_utc, seg.occupied_end_utc, '[)'
        ) && pg_catalog.tstzrange(
          NEW.start_time_utc, NEW.end_time_utc, '[)'
        )
    )
  ORDER BY r.display_order, r.id
  LIMIT 1;

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01', MESSAGE = 'active resource unavailable';
  END IF;

  NEW.resource_id := v_resource_id;
  RETURN NEW;
END
$function$;

-- Keep the established vacation/resource guard, but do not require a physical
-- resource for a service explicitly configured with resource mode `none`.
CREATE OR REPLACE FUNCTION public.enforce_booking_operational_capacity_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_salon_id uuid;
  v_staff_id uuid;
  v_service_id uuid;
  v_resource_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_live boolean;
  v_timezone text;
  v_resources_enabled boolean;
  v_resource_requirement_mode text := 'salon_default';
  v_local_start_date date;
  v_local_end_date date;
BEGIN
  IF TG_TABLE_NAME = 'bookings' THEN
    v_salon_id := NEW.salon_id;
    v_staff_id := NEW.staff_id;
    v_service_id := NEW.service_id;
    v_resource_id := NEW.resource_id;
    v_start := NEW.start_time_utc;
    v_end := NEW.end_time_utc;
    v_live := NEW.deleted_at IS NULL
      AND NEW.status NOT IN ('cancelled', 'no_show', 'completed');
  ELSIF TG_TABLE_NAME = 'booking_service_segments' THEN
    v_salon_id := NEW.salon_id;
    v_staff_id := NEW.staff_id;
    v_service_id := NEW.service_id;
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
    RETURN NEW;
  END IF;

  SELECT
    nullif(pg_catalog.btrim(s.timezone), ''),
    s.resources_enabled,
    svc.resource_requirement_mode
  INTO v_timezone, v_resources_enabled, v_resource_requirement_mode
  FROM public.salons AS s
  JOIN public.services AS svc
    ON svc.id = v_service_id
   AND svc.salon_id = s.id
   AND svc.deleted_at IS NULL
  WHERE s.id = v_salon_id;
  IF NOT FOUND OR v_timezone IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names AS tz
    WHERE tz.name = v_timezone
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023', MESSAGE = 'salon timezone or service unavailable';
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

  IF v_resources_enabled IS TRUE
     AND v_resource_requirement_mode <> 'none' THEN
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
END
$function$;

CREATE OR REPLACE FUNCTION public.enforce_turniq_assignment_confirmation_safety()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_assignment public.turniq_assignments%ROWTYPE;
  v_shift public.turniq_shift_sessions%ROWTYPE;
  v_main public.services%ROWTYPE;
  v_addon public.services%ROWTYPE;
  v_timezone text;
  v_resources_enabled boolean := false;
  v_safe_end timestamptz;
  v_catalog_minutes integer;
  v_required_kind text;
  v_addon_required_kind text;
  v_snapshot jsonb;
  v_current_shifts jsonb;
  v_current_catalog jsonb;
  v_current_services jsonb;
  v_current_resources jsonb;
  v_current_capacity jsonb;
  v_business_date date;
  v_day_start timestamptz;
  v_day_end timestamptz;
BEGIN
  IF NEW.schedule_model <> 'single'
     OR NEW.deleted_at IS NOT NULL
     OR NEW.status <> 'confirmed'
     OR NEW.staff_id IS NULL
     OR NOT (
       OLD.staff_id IS DISTINCT FROM NEW.staff_id
       OR OLD.status IS DISTINCT FROM NEW.status
       OR OLD.resource_id IS DISTINCT FROM NEW.resource_id
     ) THEN
    RETURN NEW;
  END IF;

  SELECT a.* INTO v_assignment
  FROM public.turniq_assignments AS a
  WHERE a.salon_id = NEW.salon_id
    AND a.booking_id = NEW.id
    AND a.status = 'recommended'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_snapshot := v_assignment.internal_decision_trace
    -> 'trustedConfirmationSnapshot';
  IF pg_catalog.jsonb_typeof(v_snapshot) <> 'object'
     OR (v_snapshot ->> 'version')::integer <> 1
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'shifts') <> 'array'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'catalog') <> 'array'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'services') <> 'array'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'resources') <> 'array'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'capacity') <> 'array'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'booking') <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ trusted confirmation snapshot is unavailable';
  END IF;

  IF NEW.service_id IS DISTINCT FROM v_assignment.service_id
     OR NEW.start_time_utc IS NULL
     OR NEW.end_time_utc IS NULL
     OR NEW.start_time_utc >= NEW.end_time_utc
     OR NEW.resource_id IS DISTINCT FROM v_assignment.resource_id
     OR EXISTS (
       SELECT 1 FROM public.booking_addons AS ba
       WHERE ba.booking_id = NEW.id
     )
     OR v_snapshot #>> '{booking,bookingId}' IS DISTINCT FROM NEW.id::text
     OR v_snapshot #>> '{booking,serviceId}' IS DISTINCT FROM NEW.service_id::text
     OR nullif(v_snapshot #>> '{booking,addonServiceId}', '')
        IS DISTINCT FROM NEW.addon_service_id::text
     OR nullif(v_snapshot #>> '{booking,resourceId}', '')
        IS DISTINCT FROM NEW.resource_id::text
     OR (v_snapshot #>> '{booking,startAtMs}')::bigint IS DISTINCT FROM
        pg_catalog.floor(
          extract(epoch FROM NEW.start_time_utc) * 1000
        )::bigint
     OR (v_snapshot #>> '{booking,endAtMs}')::bigint IS DISTINCT FROM
        pg_catalog.floor(
          extract(epoch FROM NEW.end_time_utc) * 1000
        )::bigint THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ recommendation booking facts changed';
  END IF;

  SELECT s.timezone, s.resources_enabled
  INTO v_timezone, v_resources_enabled
  FROM public.salons AS s
  WHERE s.id = NEW.salon_id;
  IF NOT FOUND OR nullif(pg_catalog.btrim(v_timezone), '') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_timezone_names AS tz
       WHERE tz.name = v_timezone
     )
     OR (v_assignment.decision_timestamp AT TIME ZONE v_timezone)::date
        IS DISTINCT FROM (NEW.start_time_utc AT TIME ZONE v_timezone)::date
     OR (NEW.start_time_utc AT TIME ZONE v_timezone)::date
        IS DISTINCT FROM (pg_catalog.transaction_timestamp()
          AT TIME ZONE v_timezone)::date THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ recommendation is outside the current business day';
  END IF;
  IF (v_snapshot ->> 'resourcesEnabled')::boolean
       IS DISTINCT FROM v_resources_enabled THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ salon resource mode changed; refresh required';
  END IF;

  v_business_date := (v_snapshot ->> 'businessDate')::date;
  v_day_start := (v_business_date::timestamp AT TIME ZONE v_timezone);
  v_day_end := ((v_business_date + 1)::timestamp AT TIME ZONE v_timezone);

  SELECT coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'shiftSessionId', sh.id::text,
        'staffId', sh.staff_id::text,
        'stateVersion', sh.state_version
      ) ORDER BY sh.id::text
    ),
    '[]'::jsonb
  )
  INTO v_current_shifts
  FROM public.turniq_shift_sessions AS sh
  WHERE sh.salon_id = NEW.salon_id
    AND sh.policy_version_id = v_assignment.policy_version_id
    AND sh.business_date = v_business_date
    AND sh.checked_out_at IS NULL;

  SELECT coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'staffId', st.id::text,
        'active', st.status = 'active',
        'capableServiceIds', coalesce((
          SELECT pg_catalog.jsonb_agg(ss.service_id::text ORDER BY ss.service_id::text)
          FROM public.staff_services AS ss
          WHERE ss.staff_id = st.id
            AND ss.service_id IN (NEW.service_id, NEW.addon_service_id)
        ), '[]'::jsonb)
      ) ORDER BY st.id::text
    ),
    '[]'::jsonb
  )
  INTO v_current_catalog
  FROM public.staff AS st
  WHERE st.salon_id = NEW.salon_id
    AND st.deleted_at IS NULL;

  SELECT coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'serviceId', svc.id::text,
        'priceCents', svc.price_cents,
        'durationMinutes', svc.duration_minutes,
        'bufferMinutes', svc.buffer_minutes,
        'resourceRequirementMode', svc.resource_requirement_mode,
        'requiredResourceKinds', pg_catalog.to_jsonb(ARRAY(
          SELECT kind
          FROM pg_catalog.unnest(svc.required_resource_kinds) AS kind
          ORDER BY kind
        ))
      ) ORDER BY svc.id::text
    ),
    '[]'::jsonb
  )
  INTO v_current_services
  FROM public.services AS svc
  WHERE svc.salon_id = NEW.salon_id
    AND svc.id IN (NEW.service_id, NEW.addon_service_id)
    AND svc.deleted_at IS NULL;

  SELECT coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'resourceId', r.id::text,
        'kind', r.kind,
        'active', r.status = 'active'
      ) ORDER BY r.id::text
    ),
    '[]'::jsonb
  )
  INTO v_current_resources
  FROM public.salon_resources AS r
  WHERE r.salon_id = NEW.salon_id
    AND r.deleted_at IS NULL;

  SELECT coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', occupied.id,
        'staffId', occupied.staff_id,
        'resourceId', occupied.resource_id,
        'startAtMs', occupied.start_at_ms,
        'endAtMs', occupied.end_at_ms,
        'status', occupied.status
      ) ORDER BY occupied.id
    ),
    '[]'::jsonb
  )
  INTO v_current_capacity
  FROM (
    SELECT
      b.id::text AS id,
      b.staff_id::text AS staff_id,
      b.resource_id::text AS resource_id,
      pg_catalog.floor(
        extract(epoch FROM b.start_time_utc) * 1000
      )::bigint AS start_at_ms,
      pg_catalog.floor(
        extract(epoch FROM b.end_time_utc) * 1000
      )::bigint AS end_at_ms,
      b.status
    FROM public.bookings AS b
    WHERE b.salon_id = NEW.salon_id
      AND b.deleted_at IS NULL
      AND b.status IN ('pending', 'confirmed', 'in_progress')
      AND b.start_time_utc < v_day_end
      AND b.end_time_utc > v_day_start
    UNION ALL
    SELECT
      'segment:' || seg.id::text,
      seg.staff_id::text,
      seg.resource_id::text,
      pg_catalog.floor(
        extract(epoch FROM seg.occupied_start_utc) * 1000
      )::bigint,
      pg_catalog.floor(
        extract(epoch FROM seg.occupied_end_utc) * 1000
      )::bigint,
      seg.reservation_status
    FROM public.booking_service_segments AS seg
    WHERE seg.salon_id = NEW.salon_id
      AND seg.reservation_status IN ('pending', 'confirmed', 'in_progress')
      AND seg.occupied_start_utc < v_day_end
      AND seg.occupied_end_utc > v_day_start
  ) AS occupied;

  IF v_snapshot -> 'shifts' IS DISTINCT FROM v_current_shifts
     OR v_snapshot -> 'catalog' IS DISTINCT FROM v_current_catalog
     OR v_snapshot -> 'services' IS DISTINCT FROM v_current_services
     OR v_snapshot -> 'resources' IS DISTINCT FROM v_current_resources
     OR v_snapshot -> 'capacity' IS DISTINCT FROM v_current_capacity THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ recommendation snapshot changed; refresh required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.staff AS st
    WHERE st.id = NEW.staff_id
      AND st.salon_id = NEW.salon_id
      AND st.status = 'active'
      AND st.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ assigned technician is inactive';
  END IF;

  SELECT sh.* INTO v_shift
  FROM public.turniq_shift_sessions AS sh
  WHERE sh.salon_id = NEW.salon_id
    AND sh.policy_version_id = v_assignment.policy_version_id
    AND sh.staff_id = NEW.staff_id
    AND sh.business_date = (NEW.start_time_utc AT TIME ZONE v_timezone)::date
    AND sh.state = 'active'
    AND sh.checked_out_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ assigned technician is not active';
  END IF;

  SELECT svc.* INTO v_main
  FROM public.services AS svc
  WHERE svc.id = NEW.service_id
    AND svc.salon_id = NEW.salon_id
    AND svc.deleted_at IS NULL
    AND svc.is_addon IS FALSE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.staff_services AS ss
    WHERE ss.staff_id = NEW.staff_id AND ss.service_id = NEW.service_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ assigned technician is not qualified for the service';
  END IF;

  v_catalog_minutes := greatest(1, v_main.duration_minutes)
    + greatest(0, v_main.buffer_minutes);

  IF NEW.addon_service_id IS NOT NULL THEN
    SELECT svc.* INTO v_addon
    FROM public.services AS svc
    WHERE svc.id = NEW.addon_service_id
      AND svc.salon_id = NEW.salon_id
      AND svc.deleted_at IS NULL
      AND svc.is_addon IS TRUE;
    IF NOT FOUND OR NOT EXISTS (
      SELECT 1 FROM public.staff_services AS ss
      WHERE ss.staff_id = NEW.staff_id
        AND ss.service_id = NEW.addon_service_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ assigned technician is not qualified for the add-on';
    END IF;
    v_catalog_minutes := v_catalog_minutes
      + greatest(1, v_addon.duration_minutes)
      + greatest(0, v_addon.buffer_minutes);
  END IF;

  v_safe_end := greatest(
    NEW.end_time_utc,
    NEW.start_time_utc
      + pg_catalog.make_interval(mins => v_catalog_minutes)
  );

  IF EXISTS (
    SELECT 1
    FROM public.bookings AS other
    WHERE other.salon_id = NEW.salon_id
      AND other.id <> NEW.id
      AND other.schedule_model = 'single'
      AND other.staff_id = NEW.staff_id
      AND other.deleted_at IS NULL
      AND other.status IN ('pending', 'confirmed', 'in_progress')
      AND other.start_time_utc < v_safe_end
      AND other.end_time_utc > NEW.start_time_utc
  ) OR EXISTS (
    SELECT 1
    FROM public.booking_service_segments AS seg
    WHERE seg.salon_id = NEW.salon_id
      AND seg.staff_id = NEW.staff_id
      AND seg.reservation_status IN ('pending', 'confirmed', 'in_progress')
      AND seg.occupied_start_utc < v_safe_end
      AND seg.occupied_end_utc > NEW.start_time_utc
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23P01',
      MESSAGE = 'TurnIQ technician appointment gap is no longer safe';
  END IF;

  IF v_resources_enabled IS TRUE THEN
    IF v_main.resource_requirement_mode = 'specific' THEN
      IF pg_catalog.cardinality(v_main.required_resource_kinds) <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
          MESSAGE = 'TurnIQ main service resource rule is unsupported';
      END IF;
      v_required_kind := v_main.required_resource_kinds[1];
    ELSIF v_main.resource_requirement_mode = 'salon_default' THEN
      SELECT r.kind INTO v_required_kind
      FROM public.salon_resources AS r
      WHERE r.id = NEW.resource_id
        AND r.salon_id = NEW.salon_id
        AND r.status = 'active'
        AND r.deleted_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23P01',
          MESSAGE = 'TurnIQ active resource is required';
      END IF;
    END IF;

    IF NEW.addon_service_id IS NOT NULL THEN
      IF v_addon.resource_requirement_mode = 'specific' THEN
        IF pg_catalog.cardinality(v_addon.required_resource_kinds) <> 1 THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'TurnIQ add-on resource rule is unsupported';
        END IF;
        v_addon_required_kind := v_addon.required_resource_kinds[1];
      ELSIF v_addon.resource_requirement_mode = 'salon_default' THEN
        SELECT r.kind INTO v_addon_required_kind
        FROM public.salon_resources AS r
        WHERE r.id = NEW.resource_id
          AND r.salon_id = NEW.salon_id
          AND r.status = 'active'
          AND r.deleted_at IS NULL;
        IF NOT FOUND THEN
          RAISE EXCEPTION USING ERRCODE = '23P01',
            MESSAGE = 'TurnIQ active add-on resource is required';
        END IF;
      END IF;
    END IF;

    IF v_required_kind IS DISTINCT FROM v_addon_required_kind
       AND v_required_kind IS NOT NULL
       AND v_addon_required_kind IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ multi-resource service is unsupported';
    END IF;
    v_required_kind := coalesce(v_required_kind, v_addon_required_kind);

    IF v_required_kind IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.salon_resources AS r
      WHERE r.id = NEW.resource_id
        AND r.salon_id = NEW.salon_id
        AND r.kind = v_required_kind
        AND r.status = 'active'
        AND r.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23P01',
        MESSAGE = 'TurnIQ resource no longer matches the service';
    END IF;

    IF NEW.resource_id IS NOT NULL AND (
      EXISTS (
        SELECT 1
        FROM public.bookings AS other
        WHERE other.salon_id = NEW.salon_id
          AND other.id <> NEW.id
          AND other.schedule_model = 'single'
          AND other.resource_id = NEW.resource_id
          AND other.deleted_at IS NULL
          AND other.status IN ('pending', 'confirmed', 'in_progress')
          AND other.start_time_utc < v_safe_end
          AND other.end_time_utc > NEW.start_time_utc
      ) OR EXISTS (
        SELECT 1
        FROM public.booking_service_segments AS seg
        WHERE seg.salon_id = NEW.salon_id
          AND seg.resource_id = NEW.resource_id
          AND seg.reservation_status IN ('pending', 'confirmed', 'in_progress')
          AND seg.occupied_start_utc < v_safe_end
          AND seg.occupied_end_utc > NEW.start_time_utc
      )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23P01',
        MESSAGE = 'TurnIQ resource is no longer available';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.enforce_turniq_assignment_confirmation_safety()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS turniq_assignment_confirmation_safety
  ON public.bookings;
CREATE TRIGGER turniq_assignment_confirmation_safety
  BEFORE UPDATE OF
    staff_id, resource_id, status, service_id, addon_service_id,
    start_time_utc, end_time_utc, deleted_at, schedule_model
  ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_turniq_assignment_confirmation_safety();

COMMENT ON FUNCTION public.enforce_turniq_assignment_confirmation_safety() IS
  'M3D fail-closed atomic revalidation for TurnIQ technician capability, same-day active shift, appointment gap and service resource before booking assignment.';

DO $proof$
DECLARE
  v_guard regprocedure :=
    'public.enforce_turniq_assignment_confirmation_safety()'::regprocedure;
  v_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(v_guard) INTO v_definition;
  IF position('public.staff_services AS ss' IN v_definition) = 0
     OR position('public.booking_service_segments AS seg' IN v_definition) = 0
     OR position('TurnIQ technician appointment gap is no longer safe' IN v_definition) = 0
     OR position('TurnIQ resource is no longer available' IN v_definition) = 0
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger
       WHERE tgrelid = 'public.bookings'::regclass
         AND tgname = 'turniq_assignment_confirmation_safety'
         AND NOT tgisinternal
     )
     OR pg_catalog.has_function_privilege('anon', v_guard, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_guard, 'EXECUTE') THEN
    RAISE EXCEPTION 'TurnIQ M3D confirmation safety boundary mismatch';
  END IF;
END
$proof$;

COMMIT;

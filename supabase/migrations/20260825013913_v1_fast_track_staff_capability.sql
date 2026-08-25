-- V1 Fast Track: preserve legacy all-capable salons while making the first
-- explicit staff/service edit atomic and permanently fail closed.

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS staff_capability_mode text NOT NULL DEFAULT 'legacy_all';

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'salons_staff_capability_mode_check'
      AND conrelid = 'public.salons'::regclass
  ) THEN
    ALTER TABLE public.salons
      ADD CONSTRAINT salons_staff_capability_mode_check
      CHECK (staff_capability_mode IN ('legacy_all', 'whitelist'))
      NOT VALID;
  END IF;
END
$constraint$;

-- A salon with an existing valid mapping has already opted into explicit
-- capabilities. Salons with no mapping retain their established V1 behavior.
UPDATE public.salons s
SET staff_capability_mode = 'whitelist'
WHERE EXISTS (
  SELECT 1
  FROM public.staff_services ss
  JOIN public.staff st ON st.id = ss.staff_id
  JOIN public.services sv ON sv.id = ss.service_id
  WHERE st.salon_id = s.id
    AND sv.salon_id = s.id
);

ALTER TABLE public.salons
  VALIDATE CONSTRAINT salons_staff_capability_mode_check;

-- RLS still limits this non-sensitive mode to the caller's salons. The
-- security-invoker RPC needs this one column without reopening management or
-- provider state hidden by the authenticated column projection.
GRANT SELECT (staff_capability_mode) ON TABLE public.salons TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_staff_capability_mode_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
BEGIN
  -- V1 has no supported path back to the ambiguous zero-row fallback. A later
  -- release must ship an explicit transition instead of flipping this bit.
  IF OLD.staff_capability_mode = 'whitelist'
     AND NEW.staff_capability_mode <> 'whitelist' THEN
    RAISE EXCEPTION 'staff_capability_mode_cannot_reopen_legacy'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_staff_capability_mode_transition
  ON public.salons;
CREATE TRIGGER enforce_staff_capability_mode_transition
BEFORE UPDATE OF staff_capability_mode
ON public.salons
FOR EACH ROW EXECUTE FUNCTION public.enforce_staff_capability_mode_transition();

REVOKE ALL ON FUNCTION public.enforce_staff_capability_mode_transition()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_staff_capability_mode_transition()
  TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_staff_capability_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_salon_id uuid;
  v_mode text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT st.salon_id, s.staff_capability_mode
    INTO v_salon_id, v_mode
    FROM public.staff st
    JOIN public.salons s ON s.id = st.salon_id
    WHERE st.id = OLD.staff_id;

    IF v_mode = 'whitelist'
       AND NOT EXISTS (
         SELECT 1
         FROM public.staff_services ss
         JOIN public.staff st ON st.id = ss.staff_id
         JOIN public.services sv ON sv.id = ss.service_id
         WHERE st.salon_id = v_salon_id
           AND sv.salon_id = v_salon_id
           AND st.deleted_at IS NULL
           AND sv.deleted_at IS NULL
           AND (ss.staff_id, ss.service_id)
             <> (OLD.staff_id, OLD.service_id)
       ) THEN
      RAISE EXCEPTION 'capability_whitelist_cannot_be_globally_empty'
        USING ERRCODE = '22023';
    END IF;

    RETURN OLD;
  END IF;

  SELECT st.salon_id, s.staff_capability_mode
  INTO v_salon_id, v_mode
  FROM public.staff st
  JOIN public.services sv
    ON sv.id = NEW.service_id
   AND sv.salon_id = st.salon_id
  JOIN public.salons s ON s.id = st.salon_id
  WHERE st.id = NEW.staff_id;

  IF v_salon_id IS NULL THEN
    RAISE EXCEPTION 'staff_service_tenant_mismatch' USING ERRCODE = '23503';
  END IF;

  -- One direct row must never turn legacy-all into a partial whitelist. The
  -- locked transition RPC seeds the legacy matrix before narrowing one staff.
  IF v_mode <> 'whitelist' THEN
    IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
      -- Trusted fixtures/maintenance may seed a complete matrix directly.
      -- The statement remains atomic; its first row permanently closes the
      -- legacy fallback before any mapping becomes visible.
      UPDATE public.salons
      SET staff_capability_mode = 'whitelist'
      WHERE id = v_salon_id;
    ELSE
      RAISE EXCEPTION 'capability_transition_requires_rpc'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS mark_staff_capability_configured
  ON public.staff_services;
DROP TRIGGER IF EXISTS enforce_staff_capability_write
  ON public.staff_services;
DROP TRIGGER IF EXISTS zz_enforce_staff_capability_write
  ON public.staff_services;
-- Keep the established same-tenant trigger first (PostgreSQL orders trigger
-- names) so existing SQLSTATE/message contracts remain unchanged.
CREATE TRIGGER zz_enforce_staff_capability_write
BEFORE INSERT OR DELETE OR UPDATE OF staff_id, service_id
ON public.staff_services
FOR EACH ROW EXECUTE FUNCTION public.enforce_staff_capability_write();

DROP FUNCTION IF EXISTS public.mark_staff_capability_configured();
REVOKE ALL ON FUNCTION public.enforce_staff_capability_write()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_staff_capability_write()
  TO service_role;

CREATE OR REPLACE FUNCTION public.salon_has_staff_services(p_salon_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $function$
  SELECT coalesce(s.staff_capability_mode = 'whitelist', false)
  FROM public.salons s
  WHERE s.id = p_salon_id
$function$;

REVOKE ALL ON FUNCTION public.salon_has_staff_services(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salon_has_staff_services(uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.salon_has_staff_services(uuid) IS
  'Returns the durable capability mode. An empty configured whitelist remains fail closed.';

CREATE OR REPLACE FUNCTION public.set_staff_service_capabilities(
  p_salon_id uuid,
  p_staff_id uuid,
  p_service_ids uuid[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_mode text;
  v_service_ids uuid[];
BEGIN
  -- service_role is reserved for server-only fixtures/maintenance. Every
  -- authenticated Data API caller must be an owner/admin of this exact salon.
  IF current_user <> 'service_role' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.salon_members sm
      WHERE sm.salon_id = p_salon_id
        AND sm.user_id = (SELECT auth.uid())
        AND sm.role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION 'owner_or_admin_required' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT s.staff_capability_mode
  INTO v_mode
  FROM public.salons s
  WHERE s.id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salon_not_found' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.staff st
  WHERE st.id = p_staff_id
    AND st.salon_id = p_salon_id
    AND st.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(
    array_agg(DISTINCT requested.service_id),
    ARRAY[]::uuid[]
  )
  INTO v_service_ids
  FROM unnest(coalesce(p_service_ids, ARRAY[]::uuid[]))
    AS requested(service_id);

  IF EXISTS (
    SELECT 1
    FROM unnest(v_service_ids) AS requested(service_id)
    LEFT JOIN public.services sv
      ON sv.id = requested.service_id
     AND sv.salon_id = p_salon_id
     AND sv.deleted_at IS NULL
    WHERE sv.id IS NULL
  ) THEN
    RAISE EXCEPTION 'service_tenant_mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_mode = 'legacy_all' THEN
    UPDATE public.salons
    SET staff_capability_mode = 'whitelist'
    WHERE id = p_salon_id;

    INSERT INTO public.staff_services (staff_id, service_id)
    SELECT st.id, sv.id
    FROM public.staff st
    CROSS JOIN public.services sv
    WHERE st.salon_id = p_salon_id
      AND st.deleted_at IS NULL
      AND sv.salon_id = p_salon_id
      AND sv.deleted_at IS NULL
    ON CONFLICT (staff_id, service_id) DO NOTHING;
  END IF;

  -- Existing booking readers preserve the legacy zero-row fallback. Until
  -- every reader consumes staff_capability_mode directly, never let an edit
  -- erase the salon's final capability row and accidentally reopen all pairs.
  IF pg_catalog.cardinality(v_service_ids) = 0
     AND NOT EXISTS (
       SELECT 1
       FROM public.staff_services ss
       JOIN public.staff st ON st.id = ss.staff_id
       JOIN public.services sv ON sv.id = ss.service_id
       WHERE st.salon_id = p_salon_id
         AND sv.salon_id = p_salon_id
         AND ss.staff_id <> p_staff_id
         AND st.deleted_at IS NULL
         AND sv.deleted_at IS NULL
     ) THEN
    RAISE EXCEPTION 'capability_whitelist_cannot_be_globally_empty'
      USING ERRCODE = '22023';
  END IF;

  -- Insert the desired rows first. Deleting stale rows afterward means the
  -- DELETE trigger never observes a transient global zero inside this atomic
  -- replacement transaction.
  INSERT INTO public.staff_services (staff_id, service_id)
  SELECT p_staff_id, requested.service_id
  FROM unnest(v_service_ids) AS requested(service_id)
  ON CONFLICT (staff_id, service_id) DO NOTHING;

  DELETE FROM public.staff_services ss
  WHERE ss.staff_id = p_staff_id
    AND NOT (ss.service_id = ANY(v_service_ids));

  -- Empty is a deliberate configured whitelist, never legacy-all.
  UPDATE public.salons
  SET staff_capability_mode = 'whitelist'
  WHERE id = p_salon_id;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_staff_service_capabilities(uuid, uuid, uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_staff_service_capabilities(uuid, uuid, uuid[])
  TO authenticated, service_role;

COMMENT ON FUNCTION public.set_staff_service_capabilities(uuid, uuid, uuid[]) IS
  'Atomically seeds legacy capability state and replaces one tenant-scoped staff whitelist without reopening the global zero-row fallback.';

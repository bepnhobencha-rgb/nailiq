BEGIN;
SET LOCAL lock_timeout = '5s';

-- The marker is deliberately versioned and absent on existing tenants. This
-- lets Production enroll new/self-service salons without changing either live
-- Hi-Lite salon. The function returns only a bounded state, never billing or
-- tenant metadata.
CREATE OR REPLACE FUNCTION public.tenant_trial_entitlement_state(
  p_salon_id uuid,
  p_now timestamptz DEFAULT pg_catalog.statement_timestamp()
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN s.id IS NULL THEN 'unknown'
    WHEN s.archived_at IS NOT NULL THEN 'archived'
    WHEN s.superadmin_locked_at IS NOT NULL THEN 'locked'
    WHEN pg_catalog.jsonb_typeof(
      s.feature_flags->'trial_expiry_policy_version'
    ) IS DISTINCT FROM 'number'
      OR coalesce(s.feature_flags->>'trial_expiry_policy_version', '') <> '1'
      THEN 'legacy'
    WHEN s.subscription_status = 'active' THEN 'active'
    WHEN s.subscription_status = 'past_due' THEN 'past_due'
    WHEN s.subscription_status = 'canceled' THEN 'canceled'
    WHEN s.subscription_status <> 'trialing' OR s.trial_ends_at IS NULL
      THEN 'unknown'
    WHEN p_now < s.trial_ends_at THEN 'active_trial'
    WHEN p_now < s.trial_ends_at + interval '7 days' THEN 'trial_continuity'
    ELSE 'trial_read_only'
  END
  FROM (SELECT 1) AS one
  LEFT JOIN public.salons AS s ON s.id = p_salon_id;
$$;

REVOKE ALL ON FUNCTION public.tenant_trial_entitlement_state(uuid,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_trial_entitlement_state(uuid,timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.public_salon_accepts_new_bookings(
  p_salon_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT
      s.profile_complete IS TRUE
      AND public.tenant_trial_entitlement_state(
        s.id,
        pg_catalog.statement_timestamp()
      ) IN ('legacy', 'active_trial', 'active', 'past_due')
    FROM public.salons AS s
    WHERE s.id = p_salon_id
  ), false);
$$;

REVOKE ALL ON FUNCTION public.public_salon_accepts_new_bookings(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_salon_accepts_new_bookings(uuid)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_trial_new_booking_boundary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state text;
BEGIN
  v_state := public.tenant_trial_entitlement_state(
    NEW.salon_id,
    pg_catalog.statement_timestamp()
  );
  IF v_state <> 'legacy'
     AND v_state NOT IN ('active_trial', 'active', 'past_due') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'NITRL',
      MESSAGE = 'trial_new_booking_paused';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_trial_new_booking_boundary()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS bookings_trial_new_booking_boundary ON public.bookings;
CREATE TRIGGER bookings_trial_new_booking_boundary
  BEFORE INSERT ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_trial_new_booking_boundary();

-- During the seven-day continuity window, the salon may service bookings that
-- already exist, but it cannot change the operational catalog or start a new
-- waitlist obligation. After continuity, booking rows are read-only too.
CREATE OR REPLACE FUNCTION public.enforce_trial_operational_write_boundary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row jsonb;
  v_salon_id uuid;
  v_state text;
  v_trial_ends_at timestamptz;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE'
    THEN pg_catalog.to_jsonb(OLD)
    ELSE pg_catalog.to_jsonb(NEW)
  END;
  v_salon_id := nullif(v_row->>'salon_id', '')::uuid;
  v_state := public.tenant_trial_entitlement_state(
    v_salon_id,
    pg_catalog.statement_timestamp()
  );

  IF TG_TABLE_NAME = 'bookings' THEN
    IF v_state = 'trial_read_only' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'NITRO',
        MESSAGE = 'trial_read_only';
    END IF;
    IF v_state = 'trial_continuity' THEN
      SELECT s.trial_ends_at INTO v_trial_ends_at
      FROM public.salons AS s WHERE s.id = v_salon_id;
      IF v_trial_ends_at IS NULL OR OLD.created_at >= v_trial_ends_at THEN
        RAISE EXCEPTION USING
          ERRCODE = 'NITRO',
          MESSAGE = 'trial_booking_outside_continuity';
      END IF;
    END IF;
  ELSIF v_state IN (
    'trial_continuity', 'trial_read_only', 'canceled', 'archived', 'locked', 'unknown'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'NITRO',
      MESSAGE = 'trial_operational_write_paused';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_trial_operational_write_boundary()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS bookings_trial_read_only_boundary ON public.bookings;
CREATE TRIGGER bookings_trial_read_only_boundary
  BEFORE UPDATE OR DELETE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_trial_operational_write_boundary();

DROP TRIGGER IF EXISTS services_trial_write_boundary ON public.services;
CREATE TRIGGER services_trial_write_boundary
  BEFORE INSERT OR UPDATE OR DELETE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.enforce_trial_operational_write_boundary();

DROP TRIGGER IF EXISTS staff_trial_write_boundary ON public.staff;
CREATE TRIGGER staff_trial_write_boundary
  BEFORE INSERT OR UPDATE OR DELETE ON public.staff
  FOR EACH ROW EXECUTE FUNCTION public.enforce_trial_operational_write_boundary();

DROP TRIGGER IF EXISTS resources_trial_write_boundary ON public.salon_resources;
CREATE TRIGGER resources_trial_write_boundary
  BEFORE INSERT OR UPDATE OR DELETE ON public.salon_resources
  FOR EACH ROW EXECUTE FUNCTION public.enforce_trial_operational_write_boundary();

DROP TRIGGER IF EXISTS waitlist_trial_write_boundary ON public.booking_waitlist_entries;
CREATE TRIGGER waitlist_trial_write_boundary
  BEFORE INSERT OR UPDATE OR DELETE ON public.booking_waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_trial_operational_write_boundary();

-- Refunds remain available so the system can return money already collected.
-- A newly claimed charge cannot cross this database boundary after trial
-- expiry, even if an application route or worker is called directly.
CREATE OR REPLACE FUNCTION public.enforce_trial_new_charge_boundary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state text;
BEGIN
  IF NEW.operation_kind NOT IN (
    'deposit_charge', 'noshow_charge', 'late_cancel_charge'
  ) THEN
    RETURN NEW;
  END IF;
  v_state := public.tenant_trial_entitlement_state(
    NEW.salon_id,
    pg_catalog.statement_timestamp()
  );
  IF v_state <> 'legacy'
     AND v_state NOT IN ('active_trial', 'active', 'past_due') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'NITRL',
      MESSAGE = 'trial_new_charge_paused';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_trial_new_charge_boundary()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS aa_payment_operations_trial_charge_boundary
  ON public.booking_payment_operations;
CREATE TRIGGER aa_payment_operations_trial_charge_boundary
  BEFORE INSERT ON public.booking_payment_operations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_trial_new_charge_boundary();

COMMENT ON FUNCTION public.tenant_trial_entitlement_state(uuid,timestamptz) IS
  'Versioned V1 trial state. Existing unmarked tenants return legacy and retain current behavior.';
COMMENT ON FUNCTION public.public_salon_accepts_new_bookings(uuid) IS
  'Public boolean only; no billing metadata. Used to disable booking UI before commit.';

COMMIT;

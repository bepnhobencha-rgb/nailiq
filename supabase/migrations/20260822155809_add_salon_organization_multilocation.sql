-- Approved 2026-08-22 product contract:
-- salons share staff, consented customer profiles, loyalty and aggregate
-- reporting only when they are explicitly linked to the same organization.
-- Existing salons are not auto-linked and existing customer data is not
-- auto-shared. This is an expand-first, fail-closed migration.

CREATE TABLE public.salon_organizations (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT salon_organizations_name_check CHECK (
    pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 120
    AND name !~ '[<>{}=&;]'
  )
);

CREATE INDEX salon_organizations_created_by_idx
  ON public.salon_organizations (created_by);

CREATE TABLE public.salon_organization_members (
  organization_id uuid NOT NULL
    REFERENCES public.salon_organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT salon_organization_members_role_check CHECK (
    role IN ('owner', 'admin', 'manager', 'member', 'analyst')
  )
);

CREATE TABLE public.salon_organization_locations (
  organization_id uuid NOT NULL
    REFERENCES public.salon_organizations(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id, salon_id),
  UNIQUE (salon_id)
);

CREATE UNIQUE INDEX salon_organization_locations_one_primary_idx
  ON public.salon_organization_locations (organization_id)
  WHERE is_primary;
CREATE INDEX salon_organization_members_user_idx
  ON public.salon_organization_members (user_id, organization_id);

CREATE TABLE public.organization_staff (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.salon_organizations(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (organization_id, id),
  CONSTRAINT organization_staff_name_check CHECK (
    pg_catalog.length(pg_catalog.btrim(display_name)) BETWEEN 1 AND 100
    AND display_name !~ '[<>{}=&;]'
  )
);

CREATE UNIQUE INDEX organization_staff_user_idx
  ON public.organization_staff (organization_id, user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX organization_staff_user_lookup_idx
  ON public.organization_staff (user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE public.organization_staff_locations (
  organization_id uuid NOT NULL,
  organization_staff_id uuid NOT NULL,
  salon_id uuid NOT NULL,
  staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_staff_id, salon_id),
  UNIQUE (organization_id, staff_id),
  FOREIGN KEY (organization_id, organization_staff_id)
    REFERENCES public.organization_staff(organization_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, salon_id)
    REFERENCES public.salon_organization_locations(organization_id, salon_id)
    ON DELETE CASCADE
);

CREATE INDEX organization_staff_locations_staff_idx
  ON public.organization_staff_locations (staff_id);
CREATE INDEX organization_staff_locations_org_salon_idx
  ON public.organization_staff_locations (organization_id, salon_id);
CREATE INDEX organization_staff_locations_org_staff_idx
  ON public.organization_staff_locations (
    organization_id,
    organization_staff_id
  );

CREATE TABLE public.organization_client_consents (
  organization_id uuid NOT NULL
    REFERENCES public.salon_organizations(id) ON DELETE CASCADE,
  client_profile_id uuid NOT NULL
    REFERENCES public.client_profiles(id) ON DELETE CASCADE,
  consent_at timestamptz NOT NULL,
  consent_source text NOT NULL,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id, client_profile_id),
  CONSTRAINT organization_client_consents_source_check CHECK (
    consent_source IN ('customer_opt_in', 'signed_agreement', 'migrated_contract')
  ),
  CONSTRAINT organization_client_consents_time_check CHECK (
    revoked_at IS NULL OR revoked_at >= consent_at
  )
);

CREATE INDEX organization_client_consents_profile_idx
  ON public.organization_client_consents (client_profile_id, organization_id);
CREATE INDEX organization_client_consents_active_idx
  ON public.organization_client_consents (organization_id, client_profile_id)
  WHERE revoked_at IS NULL;
CREATE INDEX organization_client_consents_granted_by_idx
  ON public.organization_client_consents (granted_by)
  WHERE granted_by IS NOT NULL;

CREATE TABLE public.organization_loyalty_programs (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE
    REFERENCES public.salon_organizations(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Chain Loyalty Rewards',
  is_active boolean NOT NULL DEFAULT true,
  points_required integer NOT NULL DEFAULT 10,
  reward_type text NOT NULL DEFAULT 'free_service',
  reward_value_cents integer,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (organization_id, id),
  CONSTRAINT organization_loyalty_programs_name_check CHECK (
    pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 120
  ),
  CONSTRAINT organization_loyalty_programs_points_check CHECK (
    points_required BETWEEN 1 AND 1000
  ),
  CONSTRAINT organization_loyalty_programs_reward_type_check CHECK (
    reward_type IN ('free_service', 'amount_off', 'custom')
  ),
  CONSTRAINT organization_loyalty_programs_reward_value_check CHECK (
    reward_value_cents IS NULL OR reward_value_cents > 0
  )
);

CREATE TABLE public.organization_loyalty_accounts (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL,
  program_id uuid NOT NULL,
  client_profile_id uuid NOT NULL
    REFERENCES public.client_profiles(id) ON DELETE RESTRICT,
  points_balance integer NOT NULL DEFAULT 0,
  lifetime_points integer NOT NULL DEFAULT 0,
  rewards_redeemed integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, program_id, client_profile_id),
  FOREIGN KEY (organization_id, program_id)
    REFERENCES public.organization_loyalty_programs(organization_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, client_profile_id)
    REFERENCES public.organization_client_consents(
      organization_id,
      client_profile_id
    ) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT organization_loyalty_accounts_balance_check CHECK (
    points_balance >= 0
    AND lifetime_points >= 0
    AND rewards_redeemed >= 0
  )
);

CREATE INDEX organization_loyalty_accounts_client_idx
  ON public.organization_loyalty_accounts (
    organization_id,
    client_profile_id
  );
CREATE INDEX organization_loyalty_accounts_profile_idx
  ON public.organization_loyalty_accounts (client_profile_id);

CREATE TABLE public.organization_loyalty_events (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL,
  account_id uuid NOT NULL,
  salon_id uuid NOT NULL,
  booking_id uuid REFERENCES public.bookings(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  points_delta integer NOT NULL,
  points_after integer NOT NULL,
  idempotency_key uuid NOT NULL,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, account_id)
    REFERENCES public.organization_loyalty_accounts(organization_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, salon_id)
    REFERENCES public.salon_organization_locations(organization_id, salon_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT organization_loyalty_events_type_check CHECK (
    event_type IN ('earn', 'redeem', 'manual_add', 'manual_remove', 'expire')
  ),
  CONSTRAINT organization_loyalty_events_delta_check CHECK (
    points_delta <> 0
  ),
  CONSTRAINT organization_loyalty_events_balance_check CHECK (
    points_after >= 0
  )
);

CREATE INDEX organization_loyalty_events_account_history_idx
  ON public.organization_loyalty_events (account_id, created_at DESC);
CREATE INDEX organization_loyalty_events_org_account_idx
  ON public.organization_loyalty_events (organization_id, account_id);
CREATE INDEX organization_loyalty_events_branch_history_idx
  ON public.organization_loyalty_events (
    organization_id,
    salon_id,
    created_at DESC
  );
CREATE INDEX organization_loyalty_events_booking_idx
  ON public.organization_loyalty_events (booking_id)
  WHERE booking_id IS NOT NULL;
CREATE INDEX organization_loyalty_events_actor_idx
  ON public.organization_loyalty_events (actor_user_id)
  WHERE actor_user_id IS NOT NULL;

COMMENT ON TABLE public.salon_organizations IS
  'Explicit business-chain boundary. Existing salons are never auto-linked.';
COMMENT ON TABLE public.salon_organization_locations IS
  'A salon belongs to at most one organization. Unlinked salons remain isolated.';
COMMENT ON TABLE public.organization_staff_locations IS
  'Maps one organization-level person to separate salon-scoped staff assignments.';
COMMENT ON TABLE public.organization_client_consents IS
  'Explicit consent boundary for sharing an existing global client identity inside one organization only.';
COMMENT ON TABLE public.organization_loyalty_events IS
  'Immutable idempotent chain-loyalty ledger with the earning/redeeming branch retained.';

CREATE OR REPLACE FUNCTION public.protect_organization_staff_location()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $protect_staff_location$
DECLARE
  v_staff_salon_id uuid;
  v_staff_user_id uuid;
  v_org_user_id uuid;
BEGIN
  SELECT s.salon_id, s.user_id
  INTO v_staff_salon_id, v_staff_user_id
  FROM public.staff AS s
  WHERE s.id = NEW.staff_id;

  IF v_staff_salon_id IS NULL OR v_staff_salon_id <> NEW.salon_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'organization staff assignment must match staff salon';
  END IF;

  SELECT os.user_id
  INTO v_org_user_id
  FROM public.organization_staff AS os
  WHERE os.organization_id = NEW.organization_id
    AND os.id = NEW.organization_staff_id;

  IF v_staff_user_id IS NOT NULL
     AND v_org_user_id IS NOT NULL
     AND v_staff_user_id <> v_org_user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'organization staff login identity mismatch';
  END IF;

  RETURN NEW;
END;
$protect_staff_location$;

REVOKE ALL ON FUNCTION public.protect_organization_staff_location()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER protect_organization_staff_location
  BEFORE INSERT OR UPDATE ON public.organization_staff_locations
  FOR EACH ROW EXECUTE FUNCTION public.protect_organization_staff_location();

CREATE OR REPLACE FUNCTION public.enforce_organization_staff_time_available(
  p_staff_id uuid,
  p_start_utc timestamptz,
  p_end_utc timestamptz,
  p_exclude_booking_id uuid DEFAULT NULL,
  p_exclude_segment_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $organization_staff_capacity$
DECLARE
  v_organization_staff_id uuid;
BEGIN
  IF p_staff_id IS NULL OR p_start_utc IS NULL OR p_end_utc IS NULL THEN
    RETURN;
  END IF;

  SELECT osl.organization_staff_id
  INTO v_organization_staff_id
  FROM public.organization_staff_locations AS osl
  WHERE osl.staff_id = p_staff_id;

  IF v_organization_staff_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_organization_staff_id::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM public.bookings AS b
    JOIN public.organization_staff_locations AS other_location
      ON other_location.staff_id = b.staff_id
    WHERE other_location.organization_staff_id = v_organization_staff_id
      AND b.schedule_model = 'single'
      AND b.status NOT IN ('cancelled', 'no_show', 'completed')
      AND b.start_time_utc IS NOT NULL
      AND b.end_time_utc IS NOT NULL
      AND b.id IS DISTINCT FROM p_exclude_booking_id
      AND pg_catalog.tstzrange(b.start_time_utc, b.end_time_utc, '[)')
        && pg_catalog.tstzrange(p_start_utc, p_end_utc, '[)')
  ) OR EXISTS (
    SELECT 1
    FROM public.booking_service_segments AS seg
    JOIN public.organization_staff_locations AS other_location
      ON other_location.staff_id = seg.staff_id
    WHERE other_location.organization_staff_id = v_organization_staff_id
      AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
      AND seg.id IS DISTINCT FROM p_exclude_segment_id
      AND seg.booking_id IS DISTINCT FROM p_exclude_booking_id
      AND pg_catalog.tstzrange(
        seg.occupied_start_utc,
        seg.occupied_end_utc,
        '[)'
      ) && pg_catalog.tstzrange(p_start_utc, p_end_utc, '[)')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01',
      MESSAGE = 'organization staff is already booked at another location';
  END IF;
END;
$organization_staff_capacity$;

REVOKE ALL ON FUNCTION public.enforce_organization_staff_time_available(
  uuid,
  timestamptz,
  timestamptz,
  uuid,
  uuid
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.enforce_organization_staff_booking_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $organization_staff_booking_capacity$
BEGIN
  IF NEW.schedule_model = 'single'
     AND NEW.status NOT IN ('cancelled', 'no_show', 'completed') THEN
    PERFORM public.enforce_organization_staff_time_available(
      NEW.staff_id,
      NEW.start_time_utc,
      NEW.end_time_utc,
      NEW.id,
      NULL
    );
  END IF;
  RETURN NEW;
END;
$organization_staff_booking_capacity$;

REVOKE ALL ON FUNCTION public.enforce_organization_staff_booking_capacity()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER enforce_organization_staff_booking_capacity
  BEFORE INSERT OR UPDATE OF staff_id, start_time_utc, end_time_utc, status,
    schedule_model
  ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_organization_staff_booking_capacity();

CREATE OR REPLACE FUNCTION public.enforce_organization_staff_segment_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $organization_staff_segment_capacity$
BEGIN
  IF NEW.reservation_status NOT IN ('cancelled', 'no_show', 'completed') THEN
    PERFORM public.enforce_organization_staff_time_available(
      NEW.staff_id,
      NEW.occupied_start_utc,
      NEW.occupied_end_utc,
      NULL,
      NEW.id
    );
  END IF;
  RETURN NEW;
END;
$organization_staff_segment_capacity$;

REVOKE ALL ON FUNCTION public.enforce_organization_staff_segment_capacity()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER enforce_organization_staff_segment_capacity
  BEFORE INSERT OR UPDATE OF staff_id, occupied_start_utc, occupied_end_utc,
    reservation_status
  ON public.booking_service_segments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_organization_staff_segment_capacity();

CREATE OR REPLACE FUNCTION public.create_salon_organization(
  p_name text,
  p_salon_ids uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $create_salon_organization$
DECLARE
  v_actor_user_id uuid := (SELECT auth.uid());
  v_organization_id uuid;
  v_distinct_count integer;
BEGIN
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;

  IF p_name IS NULL
     OR pg_catalog.length(pg_catalog.btrim(p_name)) NOT BETWEEN 1 AND 120
     OR p_name ~ '[<>{}=&;]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid organization name';
  END IF;

  SELECT pg_catalog.count(DISTINCT salon_id)::integer
  INTO v_distinct_count
  FROM pg_catalog.unnest(p_salon_ids) AS requested(salon_id)
  WHERE salon_id IS NOT NULL;

  IF v_distinct_count < 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'an organization requires at least two distinct salons';
  END IF;

  IF (
    SELECT pg_catalog.count(DISTINCT sm.salon_id)
    FROM public.salon_members AS sm
    WHERE sm.user_id = v_actor_user_id
      AND sm.role = 'owner'
      AND sm.salon_id = ANY(p_salon_ids)
  ) <> v_distinct_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'owner access is required for every organization salon';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.salon_organization_locations AS existing
    WHERE existing.salon_id = ANY(p_salon_ids)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'a requested salon already belongs to an organization';
  END IF;

  INSERT INTO public.salon_organizations (name, created_by)
  VALUES (pg_catalog.btrim(p_name), v_actor_user_id)
  RETURNING id INTO v_organization_id;

  INSERT INTO public.salon_organization_members (
    organization_id,
    user_id,
    role
  ) VALUES (v_organization_id, v_actor_user_id, 'owner');

  INSERT INTO public.salon_organization_locations (
    organization_id,
    salon_id,
    is_primary
  )
  SELECT
    v_organization_id,
    requested.salon_id,
    requested.ordinality = 1
  FROM pg_catalog.unnest(p_salon_ids) WITH ORDINALITY
    AS requested(salon_id, ordinality)
  WHERE requested.salon_id IS NOT NULL
  ORDER BY requested.ordinality
  ON CONFLICT (organization_id, salon_id) DO NOTHING;

  RETURN v_organization_id;
END;
$create_salon_organization$;

REVOKE ALL ON FUNCTION public.create_salon_organization(text, uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_salon_organization(text, uuid[])
  TO authenticated;

CREATE OR REPLACE FUNCTION public.list_organization_clients(
  p_organization_id uuid
)
RETURNS TABLE (
  client_profile_id uuid,
  phone text,
  name text,
  email text,
  is_vip boolean,
  location_count bigint,
  completed_visits bigint,
  total_spent_cents bigint,
  last_visit_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $list_organization_clients$
DECLARE
  v_actor_user_id uuid := (SELECT auth.uid());
BEGIN
  IF v_actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.salon_organization_members AS som
    WHERE som.organization_id = p_organization_id
      AND som.user_id = v_actor_user_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'organization access denied';
  END IF;

  RETURN QUERY
  SELECT
    cp.id,
    cp.phone,
    cp.name,
    cp.email,
    cp.is_vip,
    (
      SELECT pg_catalog.count(DISTINCT sc.salon_id)
      FROM public.salon_clients AS sc
      JOIN public.salon_organization_locations AS sol
        ON sol.organization_id = occ.organization_id
        AND sol.salon_id = sc.salon_id
      WHERE sc.client_profile_id = cp.id
    ),
    (
      SELECT pg_catalog.count(DISTINCT b.id)
      FROM public.bookings AS b
      JOIN public.salon_organization_locations AS sol
        ON sol.organization_id = occ.organization_id
        AND sol.salon_id = b.salon_id
      WHERE b.client_profile_id = cp.id
        AND b.status = 'completed'
        AND b.deleted_at IS NULL
    ),
    (
      SELECT coalesce(
        pg_catalog.sum(scs.total_spend_cents),
        0
      )::bigint
      FROM public.salon_client_spend AS scs
      JOIN public.salon_organization_locations AS sol
        ON sol.organization_id = occ.organization_id
        AND sol.salon_id = scs.salon_id
      WHERE scs.client_profile_id = cp.id
    ),
    (
      SELECT pg_catalog.max(b.start_time_utc)
      FROM public.bookings AS b
      JOIN public.salon_organization_locations AS sol
        ON sol.organization_id = occ.organization_id
        AND sol.salon_id = b.salon_id
      WHERE b.client_profile_id = cp.id
        AND b.deleted_at IS NULL
    )
  FROM public.organization_client_consents AS occ
  JOIN public.client_profiles AS cp
    ON cp.id = occ.client_profile_id
  WHERE occ.organization_id = p_organization_id
    AND occ.revoked_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.salon_clients AS sc
      JOIN public.salon_organization_locations AS sol
        ON sol.organization_id = occ.organization_id
        AND sol.salon_id = sc.salon_id
      WHERE sc.client_profile_id = cp.id
    );
END;
$list_organization_clients$;

REVOKE ALL ON FUNCTION public.list_organization_clients(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_organization_clients(uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.apply_organization_loyalty_event(
  p_organization_id uuid,
  p_salon_id uuid,
  p_client_profile_id uuid,
  p_booking_id uuid,
  p_event_type text,
  p_points_delta integer,
  p_idempotency_key uuid,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  event_id uuid,
  points_after integer,
  applied boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $apply_organization_loyalty_event$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_program_id uuid;
  v_account public.organization_loyalty_accounts%ROWTYPE;
  v_existing public.organization_loyalty_events%ROWTYPE;
  v_points_required integer;
  v_points_after integer;
  v_event_id uuid;
BEGIN
  IF v_role <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  IF p_event_type NOT IN ('earn', 'redeem', 'manual_add', 'manual_remove', 'expire')
     OR p_points_delta = 0
     OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid loyalty event';
  END IF;

  IF (p_event_type IN ('earn', 'manual_add') AND p_points_delta < 0)
     OR (p_event_type IN ('redeem', 'manual_remove', 'expire') AND p_points_delta > 0) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'loyalty event direction mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.salon_organization_locations AS sol
    WHERE sol.organization_id = p_organization_id
      AND sol.salon_id = p_salon_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'salon is outside organization';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_client_consents AS occ
    WHERE occ.organization_id = p_organization_id
      AND occ.client_profile_id = p_client_profile_id
      AND occ.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'active organization sharing consent required';
  END IF;

  IF p_booking_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.bookings AS b
    WHERE b.id = p_booking_id
      AND b.salon_id = p_salon_id
      AND b.client_profile_id = p_client_profile_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'booking loyalty scope mismatch';
  END IF;

  IF p_event_type = 'earn' AND NOT EXISTS (
    SELECT 1
    FROM public.bookings AS b
    WHERE b.id = p_booking_id
      AND b.salon_id = p_salon_id
      AND b.client_profile_id = p_client_profile_id
      AND b.status = 'completed'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'loyalty earn requires a completed booking';
  END IF;

  -- Serialize identical retries before inspecting the immutable ledger. A
  -- response-loss replay then returns the committed event instead of racing
  -- into the unique constraint.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_organization_id::text || ':' || p_idempotency_key::text,
      1
    )
  );

  SELECT e.*
  INTO v_existing
  FROM public.organization_loyalty_events AS e
  WHERE e.organization_id = p_organization_id
    AND e.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.salon_id <> p_salon_id
       OR v_existing.booking_id IS DISTINCT FROM p_booking_id
       OR v_existing.event_type <> p_event_type
       OR v_existing.points_delta <> p_points_delta THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'loyalty idempotency payload mismatch';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.points_after, false;
    RETURN;
  END IF;

  SELECT p.id, p.points_required
  INTO v_program_id, v_points_required
  FROM public.organization_loyalty_programs AS p
  WHERE p.organization_id = p_organization_id
    AND p.is_active;

  IF v_program_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'active organization loyalty program required';
  END IF;

  IF p_event_type = 'redeem' AND p_points_delta <> -v_points_required THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'loyalty redemption must consume one configured reward';
  END IF;

  INSERT INTO public.organization_loyalty_accounts (
    organization_id,
    program_id,
    client_profile_id
  ) VALUES (
    p_organization_id,
    v_program_id,
    p_client_profile_id
  )
  ON CONFLICT (organization_id, program_id, client_profile_id) DO NOTHING;

  SELECT a.*
  INTO v_account
  FROM public.organization_loyalty_accounts AS a
  WHERE a.organization_id = p_organization_id
    AND a.program_id = v_program_id
    AND a.client_profile_id = p_client_profile_id
  FOR UPDATE;

  v_points_after := v_account.points_balance + p_points_delta;
  IF v_points_after < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'insufficient organization loyalty balance';
  END IF;

  UPDATE public.organization_loyalty_accounts
  SET points_balance = v_points_after,
      lifetime_points = lifetime_points + greatest(p_points_delta, 0),
      rewards_redeemed = rewards_redeemed
        + CASE WHEN p_event_type = 'redeem' THEN 1 ELSE 0 END,
      updated_at = transaction_timestamp()
  WHERE id = v_account.id;

  INSERT INTO public.organization_loyalty_events (
    organization_id,
    account_id,
    salon_id,
    booking_id,
    event_type,
    points_delta,
    points_after,
    idempotency_key,
    actor_user_id
  ) VALUES (
    p_organization_id,
    v_account.id,
    p_salon_id,
    p_booking_id,
    p_event_type,
    p_points_delta,
    v_points_after,
    p_idempotency_key,
    p_actor_user_id
  ) RETURNING id INTO v_event_id;

  RETURN QUERY SELECT v_event_id, v_points_after, true;
END;
$apply_organization_loyalty_event$;

REVOKE ALL ON FUNCTION public.apply_organization_loyalty_event(
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  integer,
  uuid,
  uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_organization_loyalty_event(
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  integer,
  uuid,
  uuid
) TO service_role;

CREATE OR REPLACE FUNCTION public.get_organization_booking_report(
  p_organization_id uuid,
  p_from_utc timestamptz,
  p_to_utc timestamptz
)
RETURNS TABLE (
  scope text,
  salon_id uuid,
  salon_name text,
  booking_count bigint,
  completed_count bigint,
  gross_booked_cents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $get_organization_booking_report$
DECLARE
  v_actor_user_id uuid := (SELECT auth.uid());
BEGIN
  IF p_from_utc IS NULL OR p_to_utc IS NULL OR p_from_utc >= p_to_utc THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid reporting interval';
  END IF;

  IF v_actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.salon_organization_members AS som
    WHERE som.organization_id = p_organization_id
      AND som.user_id = v_actor_user_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'organization access denied';
  END IF;

  RETURN QUERY
  WITH branch_rows AS (
    SELECT
      sol.salon_id,
      s.name AS salon_name,
      pg_catalog.count(b.id)::bigint AS booking_count,
      pg_catalog.count(b.id) FILTER (WHERE b.status = 'completed')::bigint
        AS completed_count,
      coalesce(pg_catalog.sum(b.price_cents), 0)::bigint
        AS gross_booked_cents
    FROM public.salon_organization_locations AS sol
    JOIN public.salons AS s ON s.id = sol.salon_id
    LEFT JOIN public.bookings AS b
      ON b.salon_id = sol.salon_id
      AND b.deleted_at IS NULL
      AND b.start_time_utc >= p_from_utc
      AND b.start_time_utc < p_to_utc
    WHERE sol.organization_id = p_organization_id
    GROUP BY sol.salon_id, s.name
  )
  SELECT
    'branch'::text,
    br.salon_id,
    br.salon_name,
    br.booking_count,
    br.completed_count,
    br.gross_booked_cents
  FROM branch_rows AS br
  UNION ALL
  SELECT
    'organization'::text,
    NULL::uuid,
    NULL::text,
    coalesce(pg_catalog.sum(br.booking_count), 0)::bigint,
    coalesce(pg_catalog.sum(br.completed_count), 0)::bigint,
    coalesce(pg_catalog.sum(br.gross_booked_cents), 0)::bigint
  FROM branch_rows AS br;
END;
$get_organization_booking_report$;

REVOKE ALL ON FUNCTION public.get_organization_booking_report(
  uuid,
  timestamptz,
  timestamptz
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_organization_booking_report(
  uuid,
  timestamptz,
  timestamptz
) TO authenticated;

ALTER TABLE public.salon_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salon_organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salon_organization_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_staff_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_client_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_loyalty_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_loyalty_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_loyalty_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.salon_organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.salon_organization_members FORCE ROW LEVEL SECURITY;
ALTER TABLE public.salon_organization_locations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_staff FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_staff_locations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_client_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_loyalty_programs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_loyalty_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_loyalty_events FORCE ROW LEVEL SECURITY;

CREATE POLICY salon_organizations_member_select
  ON public.salon_organizations
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.salon_organization_members AS som
    WHERE som.organization_id = salon_organizations.id
      AND som.user_id = (SELECT auth.uid())
  ));

CREATE POLICY salon_organization_members_self_select
  ON public.salon_organization_members
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY salon_organization_locations_member_select
  ON public.salon_organization_locations
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.salon_organization_members AS som
    WHERE som.organization_id = salon_organization_locations.organization_id
      AND som.user_id = (SELECT auth.uid())
  ));

CREATE POLICY organization_staff_member_select
  ON public.organization_staff
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.salon_organization_members AS som
    WHERE som.organization_id = organization_staff.organization_id
      AND som.user_id = (SELECT auth.uid())
  ));

CREATE POLICY organization_staff_locations_member_select
  ON public.organization_staff_locations
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.salon_organization_members AS som
    WHERE som.organization_id = organization_staff_locations.organization_id
      AND som.user_id = (SELECT auth.uid())
  ));

CREATE POLICY organization_client_consents_member_select
  ON public.organization_client_consents
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.salon_organization_members AS som
    WHERE som.organization_id = organization_client_consents.organization_id
      AND som.user_id = (SELECT auth.uid())
  ));

CREATE POLICY organization_loyalty_programs_member_select
  ON public.organization_loyalty_programs
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.salon_organization_members AS som
    WHERE som.organization_id = organization_loyalty_programs.organization_id
      AND som.user_id = (SELECT auth.uid())
  ));

CREATE POLICY organization_loyalty_accounts_member_select
  ON public.organization_loyalty_accounts
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.salon_organization_members AS som
    WHERE som.organization_id = organization_loyalty_accounts.organization_id
      AND som.user_id = (SELECT auth.uid())
  ));

CREATE POLICY organization_loyalty_events_member_select
  ON public.organization_loyalty_events
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.salon_organization_members AS som
    WHERE som.organization_id = organization_loyalty_events.organization_id
      AND som.user_id = (SELECT auth.uid())
  ));

REVOKE ALL ON TABLE public.salon_organizations
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.salon_organization_members
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.salon_organization_locations
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.organization_staff
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.organization_staff_locations
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.organization_client_consents
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.organization_loyalty_programs
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.organization_loyalty_accounts
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.organization_loyalty_events
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.salon_organizations TO authenticated;
GRANT SELECT ON TABLE public.salon_organization_members TO authenticated;
GRANT SELECT ON TABLE public.salon_organization_locations TO authenticated;
GRANT SELECT ON TABLE public.organization_staff TO authenticated;
GRANT SELECT ON TABLE public.organization_staff_locations TO authenticated;
GRANT SELECT ON TABLE public.organization_client_consents TO authenticated;
GRANT SELECT ON TABLE public.organization_loyalty_programs TO authenticated;
GRANT SELECT ON TABLE public.organization_loyalty_accounts TO authenticated;
GRANT SELECT ON TABLE public.organization_loyalty_events TO authenticated;

GRANT ALL ON TABLE public.salon_organizations TO service_role;
GRANT ALL ON TABLE public.salon_organization_members TO service_role;
GRANT ALL ON TABLE public.salon_organization_locations TO service_role;
GRANT ALL ON TABLE public.organization_staff TO service_role;
GRANT ALL ON TABLE public.organization_staff_locations TO service_role;
GRANT ALL ON TABLE public.organization_client_consents TO service_role;
GRANT ALL ON TABLE public.organization_loyalty_programs TO service_role;
GRANT ALL ON TABLE public.organization_loyalty_accounts TO service_role;
GRANT ALL ON TABLE public.organization_loyalty_events TO service_role;

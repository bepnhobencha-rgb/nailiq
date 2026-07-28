-- Reversible, tenant-scoped customer identity merges.
--
-- client_profiles is intentionally global, so a salon owner must never
-- soft-delete or rewrite another salon's customer identity.  This layer keeps
-- the global profiles intact and records a salon-local alias instead. Existing
-- and future bookings are stamped with the canonical profile id while their
-- original contact phone remains untouched.

CREATE TABLE public.salon_client_identity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  canonical_profile_id uuid NOT NULL
    REFERENCES public.client_profiles(id) ON DELETE RESTRICT,
  alias_profile_id uuid NOT NULL
    REFERENCES public.client_profiles(id) ON DELETE RESTRICT,
  alias_phone text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salon_client_identity_alias_distinct_profiles CHECK (
    canonical_profile_id <> alias_profile_id
  ),
  CONSTRAINT salon_client_identity_alias_phone_present CHECK (
    char_length(btrim(alias_phone)) BETWEEN 6 AND 32
  ),
  CONSTRAINT salon_client_identity_alias_revocation_shape CHECK (
    (active AND revoked_by IS NULL AND revoked_at IS NULL)
    OR
    (NOT active AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  ),
  UNIQUE (salon_id, alias_profile_id)
);

CREATE UNIQUE INDEX salon_client_identity_aliases_active_phone_idx
  ON public.salon_client_identity_aliases (salon_id, alias_phone)
  WHERE active;

CREATE INDEX salon_client_identity_aliases_canonical_idx
  ON public.salon_client_identity_aliases
    (salon_id, canonical_profile_id)
  WHERE active;

COMMENT ON TABLE public.salon_client_identity_aliases IS
  'Reversible salon-local mapping from a duplicate profile/phone to the canonical customer identity. Global client_profiles rows are never deleted by salon operators.';

CREATE TABLE public.salon_client_identity_merge_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias_id uuid NOT NULL
    REFERENCES public.salon_client_identity_aliases(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('merge', 'revoke')),
  canonical_profile_id uuid NOT NULL
    REFERENCES public.client_profiles(id) ON DELETE RESTRICT,
  alias_profile_id uuid NOT NULL
    REFERENCES public.client_profiles(id) ON DELETE RESTRICT,
  alias_phone text NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500),
  affected_bookings integer NOT NULL CHECK (affected_bookings >= 0),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role text NOT NULL CHECK (actor_role = 'owner'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX salon_client_identity_merge_events_history_idx
  ON public.salon_client_identity_merge_events
    (salon_id, created_at DESC, id DESC);

COMMENT ON TABLE public.salon_client_identity_merge_events IS
  'Immutable audit trail for salon-local customer identity merge and revoke decisions.';

ALTER TABLE public.salon_client_identity_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salon_client_identity_merge_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "salon managers read client identity aliases"
  ON public.salon_client_identity_aliases
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.salon_members sm
      WHERE sm.salon_id = salon_client_identity_aliases.salon_id
        AND sm.user_id = (SELECT auth.uid())
        AND sm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "salon managers read client identity merge history"
  ON public.salon_client_identity_merge_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.salon_members sm
      WHERE sm.salon_id = salon_client_identity_merge_events.salon_id
        AND sm.user_id = (SELECT auth.uid())
        AND sm.role IN ('owner', 'admin')
    )
  );

-- Reads are tenant-scoped through RLS. Writes are intentionally server-only:
-- the server action performs a fresh membership/role check and the RPC repeats
-- that check inside the transaction.
REVOKE ALL ON TABLE public.salon_client_identity_aliases
  FROM anon, authenticated;
REVOKE ALL ON TABLE public.salon_client_identity_merge_events
  FROM anon, authenticated;
GRANT SELECT ON TABLE public.salon_client_identity_aliases TO authenticated;
GRANT SELECT ON TABLE public.salon_client_identity_merge_events TO authenticated;
GRANT ALL ON TABLE public.salon_client_identity_aliases TO service_role;
GRANT ALL ON TABLE public.salon_client_identity_merge_events TO service_role;

CREATE OR REPLACE FUNCTION public.merge_salon_client_identity(
  p_salon_id uuid,
  p_canonical_profile_id uuid,
  p_alias_profile_id uuid,
  p_reason text,
  p_actor_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_alias public.salon_client_identity_aliases%ROWTYPE;
  v_alias_phone text;
  v_affected integer := 0;
BEGIN
  IF p_salon_id IS NULL
     OR p_canonical_profile_id IS NULL
     OR p_alias_profile_id IS NULL
     OR p_canonical_profile_id = p_alias_profile_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_args');
  END IF;

  IF char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 500 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_reason');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.salon_members sm
    WHERE sm.salon_id = p_salon_id
      AND sm.user_id = p_actor_user_id
      AND sm.role = 'owner'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'forbidden');
  END IF;

  PERFORM 1
  FROM public.client_profiles cp
  WHERE cp.id = p_canonical_profile_id
    AND cp.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'canonical_not_found');
  END IF;

  SELECT cp.phone
  INTO v_alias_phone
  FROM public.client_profiles cp
  WHERE cp.id = p_alias_profile_id
    AND cp.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'alias_not_found');
  END IF;

  -- Both profiles must already be visible in this salon. This prevents a
  -- service-layer bug from attaching an arbitrary global customer profile.
  IF NOT EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.salon_id = p_salon_id
      AND (
        b.client_profile_id = p_canonical_profile_id
        OR b.client_phone = (
          SELECT phone FROM public.client_profiles
          WHERE id = p_canonical_profile_id
        )
      )
    UNION ALL
    SELECT 1
    FROM public.salon_clients sc
    WHERE sc.salon_id = p_salon_id
      AND sc.client_profile_id = p_canonical_profile_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'canonical_not_in_salon');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.salon_id = p_salon_id
      AND (
        b.client_profile_id = p_alias_profile_id
        OR b.client_phone = v_alias_phone
      )
    UNION ALL
    SELECT 1
    FROM public.salon_clients sc
    WHERE sc.salon_id = p_salon_id
      AND sc.client_profile_id = p_alias_profile_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'alias_not_in_salon');
  END IF;

  -- Keep the graph one level deep. A canonical profile cannot itself be an
  -- active alias, and a canonical cannot already point at the alias.
  IF EXISTS (
    SELECT 1
    FROM public.salon_client_identity_aliases a
    WHERE a.salon_id = p_salon_id
      AND a.active
      AND (
        a.alias_profile_id = p_canonical_profile_id
        OR (
          a.canonical_profile_id = p_alias_profile_id
          AND a.alias_profile_id = p_canonical_profile_id
        )
      )
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'merge_chain_not_allowed');
  END IF;

  INSERT INTO public.salon_client_identity_aliases (
    salon_id,
    canonical_profile_id,
    alias_profile_id,
    alias_phone,
    active,
    created_by,
    revoked_by,
    revoked_at,
    updated_at
  ) VALUES (
    p_salon_id,
    p_canonical_profile_id,
    p_alias_profile_id,
    v_alias_phone,
    true,
    p_actor_user_id,
    NULL,
    NULL,
    now()
  )
  ON CONFLICT (salon_id, alias_profile_id)
  DO UPDATE SET
    canonical_profile_id = EXCLUDED.canonical_profile_id,
    alias_phone = EXCLUDED.alias_phone,
    active = true,
    created_by = EXCLUDED.created_by,
    created_at = now(),
    revoked_by = NULL,
    revoked_at = NULL,
    updated_at = now()
  RETURNING * INTO v_alias;

  UPDATE public.bookings b
  SET client_profile_id = p_canonical_profile_id
  WHERE b.salon_id = p_salon_id
    AND (
      b.client_profile_id = p_alias_profile_id
      OR (
        b.client_phone = v_alias_phone
        AND (
          b.client_profile_id IS NULL
          OR b.client_profile_id = p_alias_profile_id
        )
      )
    );
  GET DIAGNOSTICS v_affected = ROW_COUNT;

  INSERT INTO public.salon_client_identity_merge_events (
    alias_id,
    salon_id,
    action,
    canonical_profile_id,
    alias_profile_id,
    alias_phone,
    reason,
    affected_bookings,
    actor_user_id,
    actor_role
  ) VALUES (
    v_alias.id,
    p_salon_id,
    'merge',
    p_canonical_profile_id,
    p_alias_profile_id,
    v_alias_phone,
    btrim(p_reason),
    v_affected,
    p_actor_user_id,
    'owner'
  );

  RETURN jsonb_build_object(
    'success', true,
    'alias_id', v_alias.id,
    'affected_bookings', v_affected
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_salon_client_identity_merge(
  p_salon_id uuid,
  p_alias_id uuid,
  p_reason text,
  p_actor_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_alias public.salon_client_identity_aliases%ROWTYPE;
  v_affected integer := 0;
BEGIN
  IF p_salon_id IS NULL OR p_alias_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_args');
  END IF;

  IF char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 500 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_reason');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.salon_members sm
    WHERE sm.salon_id = p_salon_id
      AND sm.user_id = p_actor_user_id
      AND sm.role = 'owner'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'forbidden');
  END IF;

  SELECT *
  INTO v_alias
  FROM public.salon_client_identity_aliases a
  WHERE a.id = p_alias_id
    AND a.salon_id = p_salon_id
    AND a.active
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'active_merge_not_found');
  END IF;

  UPDATE public.bookings b
  SET client_profile_id = v_alias.alias_profile_id
  WHERE b.salon_id = p_salon_id
    AND b.client_profile_id = v_alias.canonical_profile_id
    AND b.client_phone = v_alias.alias_phone;
  GET DIAGNOSTICS v_affected = ROW_COUNT;

  UPDATE public.salon_client_identity_aliases
  SET active = false,
      revoked_by = p_actor_user_id,
      revoked_at = now(),
      updated_at = now()
  WHERE id = v_alias.id;

  INSERT INTO public.salon_client_identity_merge_events (
    alias_id,
    salon_id,
    action,
    canonical_profile_id,
    alias_profile_id,
    alias_phone,
    reason,
    affected_bookings,
    actor_user_id,
    actor_role
  ) VALUES (
    v_alias.id,
    p_salon_id,
    'revoke',
    v_alias.canonical_profile_id,
    v_alias.alias_profile_id,
    v_alias.alias_phone,
    btrim(p_reason),
    v_affected,
    p_actor_user_id,
    'owner'
  );

  RETURN jsonb_build_object(
    'success', true,
    'alias_id', v_alias.id,
    'affected_bookings', v_affected
  );
END;
$$;

-- Stamp every new/updated booking with the salon-local canonical profile. The
-- booking's original client_phone remains unchanged so confirmations still use
-- the number the customer supplied and revocation stays lossless.
CREATE OR REPLACE FUNCTION public.apply_salon_client_identity_alias()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_canonical uuid;
BEGIN
  SELECT a.canonical_profile_id
  INTO v_canonical
  FROM public.salon_client_identity_aliases a
  WHERE a.salon_id = NEW.salon_id
    AND a.active
    AND (
      a.alias_profile_id = NEW.client_profile_id
      OR a.alias_phone = NEW.client_phone
    )
  ORDER BY
    CASE WHEN a.alias_profile_id = NEW.client_profile_id THEN 0 ELSE 1 END,
    a.updated_at DESC
  LIMIT 1;

  IF v_canonical IS NOT NULL THEN
    NEW.client_profile_id := v_canonical;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_apply_salon_client_identity_alias
  ON public.bookings;
CREATE TRIGGER bookings_apply_salon_client_identity_alias
  BEFORE INSERT OR UPDATE OF salon_id, client_phone, client_profile_id
  ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.apply_salon_client_identity_alias();

-- Directory reads collapse active aliases to the canonical profile while
-- preserving alias phones as searchable terms.
CREATE OR REPLACE FUNCTION public.search_salon_clients(
  p_salon_id uuid,
  p_search text,
  p_limit integer,
  p_offset integer
) RETURNS TABLE(
  client_profile_id uuid,
  phone text,
  name text,
  email text,
  is_vip boolean,
  notes text,
  visit_count integer,
  last_visit timestamptz,
  total_spent_cents bigint,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH booking_identity AS (
    SELECT
      b.id,
      b.status,
      b.start_time_utc,
      b.price_cents,
      b.addon_price_cents,
      b.client_phone,
      coalesce(a.canonical_profile_id, b.client_profile_id, phone_cp.id)
        AS resolved_profile_id
    FROM public.bookings b
    LEFT JOIN public.client_profiles phone_cp
      ON phone_cp.phone = b.client_phone
     AND phone_cp.deleted_at IS NULL
    LEFT JOIN public.salon_client_identity_aliases a
      ON a.salon_id = b.salon_id
     AND a.active
     AND (
       a.alias_profile_id = coalesce(b.client_profile_id, phone_cp.id)
       OR a.alias_phone = b.client_phone
     )
    WHERE b.salon_id = p_salon_id
  ),
  linked_profiles AS (
    SELECT DISTINCT bi.resolved_profile_id AS profile_id
    FROM booking_identity bi
    WHERE bi.resolved_profile_id IS NOT NULL
    UNION
    SELECT DISTINCT coalesce(a.canonical_profile_id, sc.client_profile_id)
    FROM public.salon_clients sc
    LEFT JOIN public.salon_client_identity_aliases a
      ON a.salon_id = sc.salon_id
     AND a.alias_profile_id = sc.client_profile_id
     AND a.active
    WHERE sc.salon_id = p_salon_id
  ),
  unprofiled AS (
    SELECT DISTINCT bi.client_phone AS phone
    FROM booking_identity bi
    WHERE bi.resolved_profile_id IS NULL
      AND nullif(btrim(bi.client_phone), '') IS NOT NULL
  ),
  directory AS (
    SELECT
      cp.id AS profile_id,
      cp.phone,
      cp.name,
      cp.email,
      cp.is_vip,
      cp.notes
    FROM linked_profiles lp
    JOIN public.client_profiles cp
      ON cp.id = lp.profile_id
     AND cp.deleted_at IS NULL
    UNION ALL
    SELECT
      NULL::uuid,
      u.phone,
      (
        SELECT b.client_name
        FROM public.bookings b
        WHERE b.salon_id = p_salon_id
          AND b.client_phone = u.phone
          AND b.client_name IS NOT NULL
        ORDER BY b.start_time_utc DESC NULLS LAST
        LIMIT 1
      ),
      NULL::text,
      false,
      NULL::text
    FROM unprofiled u
  ),
  filtered AS (
    SELECT d.*
    FROM directory d
    WHERE p_search IS NULL
      OR p_search = ''
      OR d.name ILIKE '%' || p_search || '%'
      OR d.phone ILIKE '%' || p_search || '%'
      OR (
        regexp_replace(p_search, '[^0-9]', '', 'g') <> ''
        AND regexp_replace(coalesce(d.phone, ''), '[^0-9]', '', 'g')
          ILIKE '%' || regexp_replace(p_search, '[^0-9]', '', 'g') || '%'
      )
      OR EXISTS (
        SELECT 1
        FROM public.salon_client_identity_aliases a
        WHERE a.salon_id = p_salon_id
          AND a.active
          AND a.canonical_profile_id = d.profile_id
          AND (
            a.alias_phone ILIKE '%' || p_search || '%'
            OR (
              regexp_replace(p_search, '[^0-9]', '', 'g') <> ''
              AND regexp_replace(a.alias_phone, '[^0-9]', '', 'g')
                ILIKE '%' || regexp_replace(p_search, '[^0-9]', '', 'g') || '%'
            )
          )
      )
  ),
  counted AS (
    SELECT count(*)::bigint AS total FROM filtered
  ),
  page AS (
    SELECT *
    FROM filtered
    ORDER BY name NULLS LAST, phone
    LIMIT greatest(p_limit, 0)
    OFFSET greatest(p_offset, 0)
  )
  SELECT
    pg.profile_id,
    pg.phone,
    pg.name,
    pg.email,
    pg.is_vip,
    pg.notes,
    coalesce(agg.visits, 0)::integer,
    agg.last_visit,
    coalesce(agg.spent, 0)::bigint,
    (SELECT total FROM counted)
  FROM page pg
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (
        WHERE bi.status IN ('completed', 'confirmed')
      ) AS visits,
      max(bi.start_time_utc) FILTER (
        WHERE bi.status IN ('completed', 'confirmed')
      ) AS last_visit,
      sum(
        coalesce(bi.price_cents, 0) + coalesce(bi.addon_price_cents, 0)
      ) FILTER (WHERE bi.status = 'completed') AS spent
    FROM booking_identity bi
    WHERE (
      pg.profile_id IS NOT NULL
      AND bi.resolved_profile_id = pg.profile_id
    ) OR (
      pg.profile_id IS NULL
      AND bi.resolved_profile_id IS NULL
      AND bi.client_phone = pg.phone
    )
  ) agg ON true
  ORDER BY pg.name NULLS LAST, pg.phone;
$$;

CREATE OR REPLACE FUNCTION public.search_salon_client_typeahead(
  p_salon_id uuid,
  p_query text,
  p_limit integer DEFAULT 8
) RETURNS TABLE(
  phone text,
  name text,
  is_vip boolean,
  visit_count integer,
  last_visit_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.phone,
    c.name,
    c.is_vip,
    c.visit_count,
    c.last_visit
  FROM public.search_salon_clients(
    p_salon_id,
    nullif(btrim(p_query), ''),
    greatest(1, least(coalesce(p_limit, 8), 20)),
    0
  ) c
  WHERE nullif(btrim(p_query), '') IS NOT NULL
  ORDER BY c.last_visit DESC NULLS LAST, c.name NULLS LAST, c.phone;
$$;

REVOKE ALL ON FUNCTION public.merge_salon_client_identity(
  uuid, uuid, uuid, text, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_salon_client_identity_merge(
  uuid, uuid, text, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_salon_client_identity_alias()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_salon_clients(
  uuid, text, integer, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_salon_client_typeahead(
  uuid, text, integer
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.merge_salon_client_identity(
  uuid, uuid, uuid, text, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_salon_client_identity_merge(
  uuid, uuid, text, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_salon_client_identity_alias()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.search_salon_clients(
  uuid, text, integer, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_salon_client_typeahead(
  uuid, text, integer
) TO service_role;

-- Revoking a customer-identity merge previously updated bookings while the
-- alias was still active. The BEFORE UPDATE canonicalization trigger therefore
-- changed client_profile_id straight back to the canonical profile, even
-- though the RPC returned success. Deactivate the locked alias first so the
-- trigger observes the intended post-revoke state. The transaction remains
-- atomic: any later failure rolls the alias update back as well.
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

  UPDATE public.salon_client_identity_aliases
  SET active = false,
      revoked_by = p_actor_user_id,
      revoked_at = now(),
      updated_at = now()
  WHERE id = v_alias.id;

  UPDATE public.bookings b
  SET client_profile_id = v_alias.alias_profile_id
  WHERE b.salon_id = p_salon_id
    AND b.client_profile_id = v_alias.canonical_profile_id
    AND b.client_phone = v_alias.alias_phone;
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

REVOKE ALL ON FUNCTION public.revoke_salon_client_identity_merge(
  uuid, uuid, text, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.revoke_salon_client_identity_merge(
  uuid, uuid, text, uuid
) TO service_role;

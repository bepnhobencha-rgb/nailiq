-- Schema-parity hardening discovered by the disposable QA rehearsal: an
-- expired or revoked activation allowlist must never trap an active SHADOW
-- pilot. Activation remains fail-closed; rollback stays available to the same
-- service-role + salon owner/admin + exact-confirmation boundary.

DO $patch$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.configure_turniq_controlled_shadow_pilot_v1(uuid,text,uuid,uuid,text,text,text,text)'::regprocedure
  ) INTO v_definition;

  v_old := $old_decl$  v_allowlist record;
  v_existing_result jsonb;$old_decl$;
  v_new := $new_decl$  v_allowlist public.turniq_shadow_pilot_allowlist%ROWTYPE;
  v_allowlist_found boolean := false;
  v_existing_result jsonb;$new_decl$;
  IF pg_catalog.strpos(v_definition, v_old) > 0 THEN
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  ELSIF pg_catalog.strpos(v_definition, v_new) = 0 THEN
    RAISE EXCEPTION 'TurnIQ controlled SHADOW allowlist declaration drifted';
  END IF;

  v_old := $old_guard$  SELECT a.* INTO v_allowlist
  FROM public.turniq_shadow_pilot_allowlist AS a
  WHERE a.salon_id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_allowlist.expected_slug IS DISTINCT FROM v_salon.slug
     OR v_allowlist.revoked_at IS NOT NULL
     OR v_allowlist.expires_at <= pg_catalog.transaction_timestamp() THEN$old_guard$;
  v_new := $new_guard$  SELECT a.* INTO v_allowlist
  FROM public.turniq_shadow_pilot_allowlist AS a
  WHERE a.salon_id = p_salon_id
  FOR UPDATE;
  v_allowlist_found := FOUND;
  IF p_action = 'activate' AND (
     NOT v_allowlist_found
     OR v_allowlist.expected_slug IS DISTINCT FROM v_salon.slug
     OR v_allowlist.revoked_at IS NOT NULL
     OR v_allowlist.expires_at <= pg_catalog.transaction_timestamp()
  ) THEN$new_guard$;
  IF pg_catalog.strpos(v_definition, v_old) > 0 THEN
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  ELSIF pg_catalog.strpos(v_definition, v_new) = 0 THEN
    RAISE EXCEPTION 'TurnIQ controlled SHADOW allowlist guard drifted';
  END IF;

  v_old := $old_snapshot$    'allowlist_expires_at', v_allowlist.expires_at$old_snapshot$;
  v_new := $new_snapshot$    'allowlist_expires_at', CASE WHEN v_allowlist_found
      THEN v_allowlist.expires_at ELSE NULL END$new_snapshot$;
  IF pg_catalog.strpos(v_definition, v_old) > 0 THEN
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  ELSIF pg_catalog.strpos(v_definition, v_new) = 0 THEN
    RAISE EXCEPTION 'TurnIQ controlled SHADOW readiness snapshot drifted';
  END IF;

  EXECUTE v_definition;
END;
$patch$;

REVOKE ALL ON FUNCTION public.configure_turniq_controlled_shadow_pilot_v1(
  uuid, text, uuid, uuid, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_turniq_controlled_shadow_pilot_v1(
  uuid, text, uuid, uuid, text, text, text, text
) TO service_role;

COMMENT ON FUNCTION public.configure_turniq_controlled_shadow_pilot_v1(
  uuid, text, uuid, uuid, text, text, text, text
) IS 'Service-role-only controlled TurnIQ SHADOW activation/rollback. Activation requires an exact unexpired allowlist row; fail-safe rollback remains available after allowlist expiry/revocation. Both require owner/admin attribution, exact confirmation and idempotent immutable receipt.';

-- Rollback: keep this safety hardening. It only broadens access to the safer
-- OFF transition and never enables a salon or provider.

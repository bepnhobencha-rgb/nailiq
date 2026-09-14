BEGIN;

-- Cron discovery is not permission to pause a tenant later. Revalidate the
-- exact observed grace under a row lock, and commit pause + audit together.
-- No subscription/trial policy or manual pause/resume behavior changes here.
CREATE FUNCTION public.pause_tenant_if_payment_grace_expired(
  p_salon_id uuid,
  p_expected_deadline timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_salon public.salons%ROWTYPE;
  v_now timestamptz;
  v_snapshot jsonb;
  v_audit_id uuid;
BEGIN
  IF p_salon_id IS NULL OR p_expected_deadline IS NULL
     OR NOT pg_catalog.isfinite(p_expected_deadline) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_input');
  END IF;

  SELECT * INTO v_salon FROM public.salons
  WHERE id = p_salon_id FOR UPDATE;
  -- Evaluate after waiting for the row lock. A payment, new grace or manual
  -- pause that committed first must not be overwritten by this stale batch.
  v_now := pg_catalog.clock_timestamp();
  IF NOT FOUND OR v_salon.archived_at IS NOT NULL
     OR v_salon.subscription_status IS DISTINCT FROM 'past_due'
     OR v_salon.payment_grace_ends_at IS DISTINCT FROM p_expected_deadline
     OR v_salon.payment_grace_ends_at > v_now THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'code', 'skipped_not_eligible', 'salon_id', p_salon_id
    );
  END IF;

  v_snapshot := pg_catalog.jsonb_build_object(
    'sms_outbound_enabled', v_salon.sms_outbound_enabled IS TRUE,
    'email_outbound_enabled', v_salon.email_outbound_enabled IS TRUE,
    'reminders_enabled', v_salon.reminders_enabled IS TRUE,
    'voice_ai_enabled', v_salon.voice_ai_enabled IS TRUE,
    'voice_ai_upsell_enabled', v_salon.voice_ai_upsell_enabled IS TRUE,
    'winback_enabled', v_salon.winback_enabled IS TRUE,
    'phone_otp_enabled', v_salon.phone_otp_enabled IS TRUE,
    'email_links_enabled', v_salon.email_links_enabled IS TRUE
  );

  UPDATE public.salons SET
    archived_at = v_now,
    tenant_pause_reason = 'non_payment',
    tenant_pause_note = 'Payment grace period expired',
    tenant_paused_by = NULL,
    tenant_pause_snapshot = v_snapshot,
    payment_grace_ends_at = NULL,
    sms_outbound_enabled = false,
    email_outbound_enabled = false,
    reminders_enabled = false,
    voice_ai_enabled = false,
    voice_ai_upsell_enabled = false,
    winback_enabled = false,
    phone_otp_enabled = false,
    email_links_enabled = false
  WHERE id = p_salon_id;

  -- Failure aborts the whole RPC transaction, including the update above.
  INSERT INTO public.superadmin_audit_logs (
    actor_user_id, actor_role, action, target_kind, target_id,
    before_jsonb, after_jsonb, reason
  ) VALUES (
    NULL, 'system', 'tenant_pause_non_payment', 'salon', p_salon_id,
    pg_catalog.jsonb_build_object(
      'subscription_status', v_salon.subscription_status,
      'payment_grace_ends_at', v_salon.payment_grace_ends_at,
      'archived_at', v_salon.archived_at,
      'outbound_snapshot', v_snapshot
    ),
    pg_catalog.jsonb_build_object(
      'archived', true, 'archived_at', v_now, 'reason', 'non_payment',
      'wixSquareChanged', false, 'source', 'tenant_payment_pause_atomic'
    ),
    'Payment grace period expired'
  ) RETURNING id INTO v_audit_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'code', 'paused', 'salon_id', p_salon_id,
    'audit_id', v_audit_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.pause_tenant_if_payment_grace_expired(uuid,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pause_tenant_if_payment_grace_expired(uuid,timestamptz)
  TO service_role;
COMMENT ON FUNCTION public.pause_tenant_if_payment_grace_expired(uuid,timestamptz) IS
  'Service-only cron CAS: exact current past-due grace and atomic pause/audit. Never changes subscription policy or provider state.';

COMMIT;

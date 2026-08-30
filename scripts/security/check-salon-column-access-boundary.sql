\set ON_ERROR_STOP on

DO $$
DECLARE
  v_member_oid oid;
  v_owner_oid oid;
  v_member_def text;
  v_owner_def text;
  v_view_options text[];
  v_unexpected_columns text;
BEGIN
  IF has_table_privilege('authenticated', 'public.salons', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated retained table-wide salons SELECT';
  END IF;

  IF NOT has_column_privilege(
    'authenticated', 'public.salons', 'timezone', 'SELECT'
  ) OR NOT has_column_privilege(
    'authenticated', 'public.salons', 'noshow_protection_enabled', 'SELECT'
  ) OR NOT has_column_privilege(
    'authenticated', 'public.salons', 'winback_enabled', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'required authenticated operational column grant missing';
  END IF;

  IF has_column_privilege(
    'authenticated', 'public.salons', 'email', 'SELECT'
  ) OR has_column_privilege(
    'authenticated', 'public.salons', 'feature_flags', 'SELECT'
  ) OR has_column_privilege(
    'authenticated', 'public.salons', 'staff_notification_settings', 'SELECT'
  ) OR has_column_privilege(
    'authenticated', 'public.salons', 'client_segment_settings', 'SELECT'
  ) OR has_column_privilege(
    'authenticated', 'public.salons', 'stripe_customer_id', 'SELECT'
  ) OR has_column_privilege(
    'authenticated', 'public.salons', 'stripe_connect_account_id', 'SELECT'
  ) OR has_column_privilege(
    'authenticated', 'public.salons', 'admin_notes', 'SELECT'
  ) OR has_column_privilege(
    'authenticated', 'public.salons', 'superadmin_locked_at', 'SELECT'
  ) OR has_column_privilege(
    'authenticated', 'public.salons', 'tenant_pause_reason', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'authenticated privileged salons column remains directly readable';
  END IF;

  SELECT c.reloptions
  INTO v_view_options
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'salon_member_operational_profiles'
    AND c.relkind = 'v';

  IF v_view_options IS NULL
     OR NOT ('security_invoker=true' = ANY(v_view_options))
     OR NOT ('security_barrier=true' = ANY(v_view_options))
  THEN
    RAISE EXCEPTION 'operational salon view is missing invoker/barrier hardening';
  END IF;

  IF has_table_privilege(
    'public', 'public.salon_member_operational_profiles', 'SELECT'
  ) OR has_table_privilege(
    'anon', 'public.salon_member_operational_profiles', 'SELECT'
  ) OR has_table_privilege(
    'service_role', 'public.salon_member_operational_profiles', 'SELECT'
  ) OR NOT has_table_privilege(
    'authenticated', 'public.salon_member_operational_profiles', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'operational salon view ACL mismatch';
  END IF;

  SELECT pg_catalog.string_agg(c.column_name, ', ' ORDER BY c.ordinal_position)
  INTO v_unexpected_columns
  FROM information_schema.columns AS c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'salon_member_operational_profiles'
    AND c.column_name IN (
      'phone', 'email', 'email_verified', 'contact_email',
      'feature_flags',
      'staff_notification_settings', 'client_segment_settings',
      'stripe_customer_id', 'stripe_subscription_id',
      'stripe_connect_account_id', 'subscription_status',
      'subscription_current_period_end', 'admin_notes',
      'superadmin_locked_at', 'owner_phone',
      'owner_notification_settings', 'ai_manager_instructions',
      'tenant_pause_reason', 'tenant_pause_note'
    );
  IF v_unexpected_columns IS NOT NULL THEN
    RAISE EXCEPTION 'operational view exposes privileged columns: %',
      v_unexpected_columns;
  END IF;

  SELECT p.oid, pg_catalog.pg_get_functiondef(p.oid)
  INTO v_member_oid, v_member_def
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'load_salon_member_operational_profile'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) =
      'p_salon_id uuid';

  SELECT p.oid, pg_catalog.pg_get_functiondef(p.oid)
  INTO v_owner_oid, v_owner_def
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'load_salon_owner_admin_settings'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) =
      'p_salon_id uuid';

  IF v_member_oid IS NULL OR v_owner_oid IS NULL THEN
    RAISE EXCEPTION 'salon role-scoped loader contract missing';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc
    WHERE oid IN (v_member_oid, v_owner_oid)
      AND prosecdef
      AND provolatile = 'v'
      AND proconfig @> ARRAY['search_path=""']::text[]
  ) <> 2 THEN
    RAISE EXCEPTION 'salon loaders are not VOLATILE hardened SECURITY DEFINER';
  END IF;

  IF position('current_auth_session_is_active()' IN v_member_def) = 0
     OR position('FOR SHARE' IN v_member_def) = 0
     OR position('staff_notification_settings' IN v_member_def) = 0
     OR position('client_segment_settings' IN v_member_def) = 0
     OR position('jsonb_object_agg(flag.key' IN v_member_def) = 0
     OR position('pg_catalog.length(coalesce' IN v_member_def) = 0
     OR position('current_auth_session_is_active()' IN v_owner_def) = 0
     OR position('for share' IN pg_catalog.lower(v_owner_def)) = 0
     OR position(
       'v_role not in (''owner'', ''admin'')'
       IN pg_catalog.lower(v_owner_def)
     ) = 0
     OR position('to_jsonb(s)' IN pg_catalog.lower(v_owner_def)) <> 0
  THEN
    RAISE EXCEPTION 'salon loader authorization/projection binding drifted';
  END IF;

  IF has_function_privilege('public', v_member_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_member_oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_member_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_member_oid, 'EXECUTE')
     OR has_function_privilege('public', v_owner_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_owner_oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_owner_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_owner_oid, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'salon loader ACL mismatch';
  END IF;
END $$;

SELECT 'salon column access boundary passed' AS result;

-- Campaign schedules, notification templates, re-opt-in send ledgers, and
-- win-back suggestions are internal automation state. Runtime access is
-- server-only and uses the service role, including the reschedule Edge
-- Function's template lookup. Remove legacy anon/authenticated authority and
-- make the service-only boundary explicit.

REVOKE ALL PRIVILEGES ON TABLE public.campaign_schedules
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.notification_templates
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.reoptin_sends
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.winback_suggestions
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.campaign_schedules TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.notification_templates TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.reoptin_sends TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.winback_suggestions TO service_role;

CREATE POLICY "deny direct API access to campaign schedules"
  ON public.campaign_schedules
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to notification templates"
  ON public.notification_templates
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to reoptin sends"
  ON public.reoptin_sends
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to winback suggestions"
  ON public.winback_suggestions
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DO $proof$
DECLARE
  v_target record;
  v_oid oid;
BEGIN
  FOR v_target IN
    SELECT *
    FROM (
      VALUES
        (
          'campaign_schedules',
          'deny direct API access to campaign schedules'
        ),
        (
          'notification_templates',
          'deny direct API access to notification templates'
        ),
        ('reoptin_sends', 'deny direct API access to reoptin sends'),
        (
          'winback_suggestions',
          'deny direct API access to winback suggestions'
        )
    ) AS expected(table_name, policy_name)
  LOOP
    SELECT c.oid
      INTO v_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v_target.table_name
      AND c.relkind = 'r';

    IF has_table_privilege(
      'anon', v_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR has_table_privilege(
      'authenticated', v_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR has_any_column_privilege(
      'anon', v_oid, 'SELECT,INSERT,UPDATE,REFERENCES'
    ) OR has_any_column_privilege(
      'authenticated', v_oid, 'SELECT,INSERT,UPDATE,REFERENCES'
    ) OR NOT has_table_privilege(
      'service_role', v_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_policy
      WHERE polrelid = v_oid
        AND polname = v_target.policy_name
        AND NOT polpermissive
        AND pg_get_expr(polqual, polrelid) = 'false'
        AND pg_get_expr(polwithcheck, polrelid) = 'false'
    ) THEN
      RAISE EXCEPTION 'notification-automation boundary mismatch on %',
        v_target.table_name;
    END IF;
  END LOOP;
END
$proof$;

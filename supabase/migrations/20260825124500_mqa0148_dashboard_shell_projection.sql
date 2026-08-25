-- MQA-0148: collapse member-authorized dashboard shell counters and billing
-- state into one service-role-only read after the application has completed
-- its active-session and exact-tenant membership checks.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.load_dashboard_shell_projection(
  p_salon_id uuid,
  p_today_start timestamptz,
  p_now timestamptz DEFAULT pg_catalog.clock_timestamp()
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'setup_wizard_completed_at', s.setup_wizard_completed_at,
    'stripe_subscription_id', s.stripe_subscription_id,
    'subscription_status', s.subscription_status,
    'trial_ends_at', s.trial_ends_at,
    'waiting_count', (
      SELECT pg_catalog.count(*)
      FROM public.bookings AS b
      WHERE b.salon_id = s.id
        AND b.status = 'waiting'
        AND b.joined_queue_at >= p_today_start
    ),
    'waitlist_count', (
      SELECT pg_catalog.count(*)
      FROM public.booking_waitlist_entries AS w
      WHERE w.salon_id = s.id
        AND w.status IN ('waiting', 'notified')
    ),
    'overdue_count', (
      SELECT pg_catalog.count(*)
      FROM public.bookings AS b
      WHERE b.salon_id = s.id
        AND b.status = 'in_progress'
        AND b.start_time_utc >= p_today_start
        AND b.end_time_utc < p_now
    ),
    'pending_approvals_count', (
      SELECT pg_catalog.count(*)
      FROM public.approval_requests AS a
      WHERE a.salon_id = s.id
        AND a.status = 'pending'
    )
  )
  FROM public.salons AS s
  WHERE s.id = p_salon_id;
$$;

REVOKE ALL ON FUNCTION public.load_dashboard_shell_projection(uuid, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_dashboard_shell_projection(uuid, timestamptz, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.load_dashboard_shell_projection(uuid, timestamptz, timestamptz) IS
  'Service-role-only dashboard shell projection; application authorization must complete before invocation.';

COMMIT;

-- TurnIQ M6 pilot evidence projection. Read-only, service-role-only and dormant
-- while the per-salon TurnIQ flag is OFF. Targets remain hypotheses until a
-- real baseline/shadow/supervised pilot produces representative observations.

CREATE OR REPLACE FUNCTION public.get_turniq_pilot_evidence_v1(
  p_salon_id uuid,
  p_business_date date,
  p_actor_user_id uuid,
  p_actor_role text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_timezone text;
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
BEGIN
  IF p_salon_id IS NULL OR p_business_date IS NULL OR p_actor_user_id IS NULL
     OR p_actor_role NOT IN ('owner', 'admin')
     OR NOT EXISTS (
       SELECT 1 FROM public.salon_members m
       WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
         AND m.role = p_actor_role
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'TurnIQ pilot evidence requires owner/admin';
  END IF;

  SELECT s.timezone INTO v_timezone
  FROM public.salons s
  WHERE s.id = p_salon_id AND s.archived_at IS NULL
    AND coalesce(
      s.feature_flags -> 'turniq_trust_engine_enabled', 'false'::jsonb
    ) = 'true'::jsonb;
  IF NOT FOUND OR coalesce(length(pg_catalog.btrim(v_timezone)), 0) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'TurnIQ is not enabled for salon';
  END IF;

  v_start := p_business_date::timestamp AT TIME ZONE v_timezone;
  v_end := (p_business_date + 1)::timestamp AT TIME ZONE v_timezone;

  WITH day_assignments AS (
    SELECT a.*
    FROM public.turniq_assignments a
    WHERE a.salon_id = p_salon_id
      AND a.decision_timestamp >= v_start AND a.decision_timestamp < v_end
  ),
  day_receipts AS (
    SELECT r.*
    FROM public.turniq_fairness_receipts r
    WHERE r.salon_id = p_salon_id
      AND r.created_at >= v_start AND r.created_at < v_end
  ),
  assignment_metrics AS (
    SELECT
      count(*)::integer AS recommendations,
      count(DISTINCT CASE
        WHEN booking_id IS NOT NULL THEN 'booking:' || booking_id::text
        ELSE 'request:' || customer_request_id::text
      END)
        FILTER (WHERE status = 'completed')::integer AS completed_customers,
      count(*) FILTER (WHERE confirmation_kind IS NOT NULL)::integer AS confirmed,
      count(*) FILTER (WHERE confirmation_kind = 'confirmed_recommendation')::integer AS accepted,
      count(*) FILTER (WHERE confirmation_kind = 'override')::integer AS overrides,
      (pg_catalog.percentile_cont(0.5) WITHIN GROUP (
        ORDER BY extract(epoch FROM (confirmed_at - decision_timestamp))
      ) FILTER (WHERE confirmed_at IS NOT NULL))::numeric AS median_assignment_seconds
    FROM day_assignments
  ),
  customer_waits AS (
    SELECT
      CASE
        WHEN a.booking_id IS NOT NULL THEN 'booking:' || a.booking_id::text
        ELSE 'request:' || a.customer_request_id::text
      END AS customer_key,
      pg_catalog.min(
        extract(epoch FROM (a.started_at - b.joined_queue_at)) / 60.0
      )::numeric AS wait_minutes
    FROM day_assignments a
    LEFT JOIN public.bookings b ON b.id = a.booking_id AND b.salon_id = a.salon_id
    WHERE b.joined_queue_at IS NOT NULL AND a.started_at IS NOT NULL
    GROUP BY CASE
      WHEN a.booking_id IS NOT NULL THEN 'booking:' || a.booking_id::text
      ELSE 'request:' || a.customer_request_id::text
    END
  ),
  wait_metrics AS (
    SELECT
      (pg_catalog.percentile_cont(0.5) WITHIN GROUP (
        ORDER BY wait_minutes
      ))::numeric AS wait_p50_minutes,
      (pg_catalog.percentile_cont(0.9) WITHIN GROUP (
        ORDER BY wait_minutes
      ))::numeric AS wait_p90_minutes
    FROM customer_waits
  ),
  walkin_metrics AS (
    SELECT
      count(*)::integer AS walkins_joined,
      count(*) FILTER (WHERE b.status = 'cancelled')::integer AS walkaways
    FROM public.bookings b
    WHERE b.salon_id = p_salon_id
      AND b.source = 'walkin'
      AND b.joined_queue_at >= v_start AND b.joined_queue_at < v_end
  ),
  opportunity AS (
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'staff_id', q.assigned_staff_id,
      'opportunity_credit_cents', q.credit_cents,
      'turns', q.turns
    ) ORDER BY q.assigned_staff_id), '[]'::jsonb) AS distribution,
    coalesce(pg_catalog.max(q.credit_cents) - pg_catalog.min(q.credit_cents), 0)::bigint AS spread_cents
    FROM (
      SELECT assigned_staff_id,
        pg_catalog.sum(opportunity_credit_cents)::bigint AS credit_cents,
        count(*)::integer AS turns
      FROM day_assignments
      WHERE status = 'completed' AND assigned_staff_id IS NOT NULL
      GROUP BY assigned_staff_id
    ) q
  ),
  request_sources AS (
    SELECT coalesce(pg_catalog.jsonb_object_agg(q.source, q.total), '{}'::jsonb) AS counts
    FROM (
      SELECT coalesce(requested_tech_source, 'none') AS source,
        count(*)::integer AS total
      FROM day_assignments
      GROUP BY coalesce(requested_tech_source, 'none')
    ) q
  ),
  trust_counts AS (
    SELECT
      (SELECT count(*)::integer FROM public.turniq_exceptions e
       WHERE e.salon_id = p_salon_id AND e.created_at >= v_start AND e.created_at < v_end) AS exceptions,
      (SELECT count(*)::integer FROM public.turniq_exceptions e
       WHERE e.salon_id = p_salon_id AND e.status IN ('open', 'acknowledged')) AS unresolved_exceptions,
      (SELECT count(*)::integer FROM public.turniq_disputes d
       WHERE d.salon_id = p_salon_id AND d.created_at >= v_start AND d.created_at < v_end) AS disputes,
      (SELECT count(*)::integer FROM public.turniq_disputes d
       WHERE d.salon_id = p_salon_id AND d.status IN ('open', 'under_review')) AS unresolved_disputes,
      (SELECT count(*)::integer FROM public.turniq_offline_reconciliations o
       WHERE o.salon_id = p_salon_id AND o.status = 'open') AS unresolved_offline_conflicts,
      (SELECT count(*)::integer FROM public.turniq_offline_reconciliations o
       WHERE o.salon_id = p_salon_id AND o.conflict_code = 'command_conflict'
         AND o.created_at >= v_start AND o.created_at < v_end) AS duplicate_command_conflicts
  ),
  receipt_metrics AS (
    SELECT count(*)::integer AS receipts,
      count(*) FILTER (WHERE r.actor_role NOT IN ('owner', 'admin'))::integer AS team_confirmed_without_owner,
      pg_catalog.sum(
        CASE WHEN r.actor_role IN ('owner', 'admin')
          THEN extract(epoch FROM (r.created_at - a.decision_timestamp))
          ELSE 0
        END
      )::numeric AS owner_decision_seconds_observed
    FROM day_receipts r
    LEFT JOIN day_assignments a ON a.id = r.assignment_id
  )
  SELECT pg_catalog.jsonb_build_object(
    'business_date', p_business_date,
    'targets_are_hypotheses', true,
    'recommendations', a.recommendations,
    'completed_customers', a.completed_customers,
    'confirmed_assignments', a.confirmed,
    'recommendation_acceptance_basis_points',
      CASE WHEN a.confirmed = 0 THEN null ELSE pg_catalog.round(a.accepted * 10000.0 / a.confirmed)::integer END,
    'overrides', a.overrides,
    'median_assignment_seconds', pg_catalog.round(a.median_assignment_seconds)::integer,
    'wait_p50_minutes', pg_catalog.round(w.wait_p50_minutes)::integer,
    'wait_p90_minutes', pg_catalog.round(w.wait_p90_minutes)::integer,
    'walkins_joined', x.walkins_joined,
    'walkaways', x.walkaways,
    'walkaway_rate_basis_points',
      CASE WHEN x.walkins_joined = 0 THEN null ELSE pg_catalog.round(x.walkaways * 10000.0 / x.walkins_joined)::integer END,
    'walkaway_rate_is_proxy', true,
    'fairness_receipts', r.receipts,
    'normal_turns_without_owner_basis_points',
      CASE WHEN r.receipts = 0 THEN null ELSE pg_catalog.round(r.team_confirmed_without_owner * 10000.0 / r.receipts)::integer END,
    'exceptions', t.exceptions,
    'unresolved_exceptions', t.unresolved_exceptions,
    'disputes', t.disputes,
    'unresolved_disputes', t.unresolved_disputes,
    'unresolved_offline_conflicts', t.unresolved_offline_conflicts,
    'duplicate_command_conflicts', t.duplicate_command_conflicts,
    'owner_decision_seconds_observed', pg_catalog.round(r.owner_decision_seconds_observed)::integer,
    'offline_loss_evidence_complete', false,
    'request_source_counts', s.counts,
    'opportunity_distribution', o.distribution,
    'opportunity_spread_cents', o.spread_cents
  ) INTO v_result
  FROM assignment_metrics a
  CROSS JOIN wait_metrics w
  CROSS JOIN opportunity o
  CROSS JOIN request_sources s
  CROSS JOIN trust_counts t
  CROSS JOIN receipt_metrics r
  CROSS JOIN walkin_metrics x;

  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.get_turniq_pilot_evidence_v1(uuid, date, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_turniq_pilot_evidence_v1(uuid, date, uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.get_turniq_pilot_evidence_v1(uuid, date, uuid, text) IS
  'Read-only owner/admin TurnIQ pilot evidence. Results are observations; target thresholds remain hypotheses until a representative pilot.';

-- Rollback: stop calling this projection and keep immutable TurnIQ ledgers.
-- Dropping the read-only function is optional and does not change live state.

-- TurnIQ M1B trust foundation.
--
-- This migration is additive and inert while
-- salons.feature_flags.turniq_trust_engine_enabled is absent/false. It does
-- not alter bookings, assignments, resources, notifications, or payments.
-- Browser roles intentionally receive no direct ledger access: future
-- role-checked projections and atomic commands are a separate milestone.
--
-- Rollback boundary: keep the feature flag OFF and stop TurnIQ readers/writers.
-- Preserve ledger rows as audit evidence; do not drop them during an incident.

CREATE TABLE public.turniq_policy_versions (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  policy_name text NOT NULL
    CHECK (length(btrim(policy_name)) BETWEEN 1 AND 120),
  business_timezone text NOT NULL
    CHECK (length(btrim(business_timezone)) BETWEEN 1 AND 100),
  effective_business_date date NOT NULL,
  fairness_band_cents integer NOT NULL DEFAULT 2000
    CHECK (fairness_band_cents BETWEEN 0 AND 10000),
  ranking_strategy text NOT NULL DEFAULT 'money_balanced_rotation_v1'
    CHECK (ranking_strategy = 'money_balanced_rotation_v1'),
  opportunity_credit_basis text NOT NULL
    DEFAULT 'catalog_list_plus_permitted_addons_before_tax_tip'
    CHECK (
      opportunity_credit_basis =
        'catalog_list_plus_permitted_addons_before_tax_tip'
    ),
  late_arrival_baseline_strategy text NOT NULL
    DEFAULT 'median_eligible_team_credit_at_checkin'
    CHECK (
      late_arrival_baseline_strategy =
        'median_eligible_team_credit_at_checkin'
    ),
  requested_technician_precedence boolean NOT NULL DEFAULT true
    CHECK (requested_technician_precedence),
  redo_turn_policy text NOT NULL DEFAULT 'owner_review'
    CHECK (redo_turn_policy IN ('consume', 'do_not_consume', 'owner_review')),
  redo_credit_policy text NOT NULL DEFAULT 'owner_review'
    CHECK (redo_credit_policy IN ('credit', 'do_not_credit', 'owner_review')),
  refusal_policy text NOT NULL DEFAULT 'move_to_end_unless_approved'
    CHECK (refusal_policy = 'move_to_end_unless_approved'),
  emergency_same_day boolean NOT NULL DEFAULT false,
  emergency_reason text,
  policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  created_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT turniq_policy_emergency_reason_check CHECK (
    (NOT emergency_same_day AND emergency_reason IS NULL)
    OR (
      emergency_same_day
      AND coalesce(length(btrim(emergency_reason)), 0) BETWEEN 1 AND 500
    )
  ),
  UNIQUE (salon_id, version),
  UNIQUE (salon_id, id)
);

CREATE INDEX turniq_policy_effective_idx
  ON public.turniq_policy_versions
    (salon_id, effective_business_date DESC, version DESC);

CREATE TABLE public.turniq_shift_sessions (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  policy_version_id uuid NOT NULL,
  staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  business_date date NOT NULL,
  checked_in_at timestamptz NOT NULL,
  checked_out_at timestamptz,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'approved_break', 'temporary_hold', 'checked_out')),
  queue_position integer NOT NULL CHECK (queue_position > 0),
  fairness_baseline_cents integer NOT NULL DEFAULT 0
    CHECK (fairness_baseline_cents >= 0),
  service_credit_since_checkin_cents integer NOT NULL DEFAULT 0
    CHECK (service_credit_since_checkin_cents >= 0),
  turns_consumed integer NOT NULL DEFAULT 0 CHECK (turns_consumed >= 0),
  hold_reason text,
  state_changed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT turniq_shift_checkout_check CHECK (
    (state = 'checked_out' AND checked_out_at IS NOT NULL)
    OR (state <> 'checked_out' AND checked_out_at IS NULL)
  ),
  CONSTRAINT turniq_shift_hold_reason_check CHECK (
    (state NOT IN ('approved_break', 'temporary_hold') AND hold_reason IS NULL)
    OR (
      state IN ('approved_break', 'temporary_hold')
      AND coalesce(length(btrim(hold_reason)), 0) BETWEEN 1 AND 500
    )
  ),
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, id)
);

CREATE UNIQUE INDEX turniq_shift_one_open_per_staff_idx
  ON public.turniq_shift_sessions (salon_id, staff_id)
  WHERE checked_out_at IS NULL;
CREATE UNIQUE INDEX turniq_shift_queue_position_idx
  ON public.turniq_shift_sessions (salon_id, business_date, queue_position)
  WHERE checked_out_at IS NULL;
CREATE INDEX turniq_shift_business_state_idx
  ON public.turniq_shift_sessions (salon_id, business_date, state, queue_position);
CREATE INDEX turniq_shift_policy_fk_idx
  ON public.turniq_shift_sessions (salon_id, policy_version_id);
CREATE INDEX turniq_shift_staff_fk_idx
  ON public.turniq_shift_sessions (staff_id);

CREATE TABLE public.turniq_assignments (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  policy_version_id uuid NOT NULL,
  shift_session_id uuid,
  booking_id uuid REFERENCES public.bookings(id) ON DELETE RESTRICT,
  booking_segment_id uuid
    REFERENCES public.booking_service_segments(id) ON DELETE RESTRICT,
  assignment_group_id uuid,
  customer_request_id uuid NOT NULL,
  recommended_staff_id uuid REFERENCES public.staff(id) ON DELETE RESTRICT,
  assigned_staff_id uuid REFERENCES public.staff(id) ON DELETE RESTRICT,
  requested_staff_id uuid REFERENCES public.staff(id) ON DELETE RESTRICT,
  service_id uuid REFERENCES public.services(id) ON DELETE RESTRICT,
  resource_id uuid REFERENCES public.salon_resources(id) ON DELETE RESTRICT,
  requested_tech_source text CHECK (
    requested_tech_source IS NULL OR requested_tech_source IN (
      'customer_selected', 'ai_confirmed', 'staff_entered', 'in_person',
      'imported', 'override', 'legacy_unknown'
    )
  ),
  request_trust_label text CHECK (
    request_trust_label IS NULL OR request_trust_label IN (
      'customer_confirmed', 'customer_claim_recorded',
      'imported_unverified', 'manager_override', 'legacy_unknown'
    )
  ),
  requested_tech_actor_ref text,
  requested_tech_recorded_at timestamptz,
  decision_timestamp timestamptz NOT NULL,
  decision_fingerprint text NOT NULL CHECK (decision_fingerprint ~ '^[0-9a-f]{64}$'),
  snapshot_version text NOT NULL
    CHECK (length(btrim(snapshot_version)) BETWEEN 1 AND 120),
  privacy_safe_explanation text NOT NULL
    CHECK (length(btrim(privacy_safe_explanation)) BETWEEN 1 AND 500),
  eligible_candidates jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(eligible_candidates) = 'array'),
  skipped_candidates jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(skipped_candidates) = 'array'),
  internal_decision_trace jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(internal_decision_trace) = 'object'),
  status text NOT NULL DEFAULT 'recommended'
    CHECK (status IN (
      'recommended', 'confirmed', 'in_progress', 'completed',
      'cancelled', 'rejected'
    )),
  confirmation_kind text CHECK (
    confirmation_kind IS NULL
    OR confirmation_kind IN ('confirmed_recommendation', 'override')
  ),
  confirmation_actor_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  override_reason text,
  opportunity_credit_cents integer NOT NULL DEFAULT 0
    CHECK (opportunity_credit_cents >= 0),
  actual_service_revenue_cents integer
    CHECK (actual_service_revenue_cents IS NULL OR actual_service_revenue_cents >= 0),
  actual_tax_cents integer
    CHECK (actual_tax_cents IS NULL OR actual_tax_cents >= 0),
  actual_tip_cents integer
    CHECK (actual_tip_cents IS NULL OR actual_tip_cents >= 0),
  turn_consumed boolean NOT NULL DEFAULT false,
  confirmed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT turniq_assignment_request_provenance_check CHECK (
    (
      requested_staff_id IS NULL
      AND requested_tech_source IS NULL
      AND request_trust_label IS NULL
      AND requested_tech_actor_ref IS NULL
      AND requested_tech_recorded_at IS NULL
    )
    OR (
      requested_staff_id IS NOT NULL
      AND requested_tech_source IS NOT NULL
      AND request_trust_label IS NOT NULL
      AND coalesce(length(btrim(requested_tech_actor_ref)), 0) BETWEEN 1 AND 200
      AND requested_tech_recorded_at IS NOT NULL
    )
  ),
  CONSTRAINT turniq_assignment_request_trust_check CHECK (
    requested_tech_source IS NULL
    OR (requested_tech_source IN ('customer_selected', 'ai_confirmed', 'in_person')
        AND request_trust_label = 'customer_confirmed')
    OR (requested_tech_source = 'staff_entered'
        AND request_trust_label = 'customer_claim_recorded')
    OR (requested_tech_source = 'imported'
        AND request_trust_label = 'imported_unverified')
    OR (requested_tech_source = 'override'
        AND request_trust_label = 'manager_override')
    OR (requested_tech_source = 'legacy_unknown'
        AND request_trust_label = 'legacy_unknown')
  ),
  CONSTRAINT turniq_assignment_timestamps_check CHECK (
    (confirmed_at IS NULL OR confirmed_at >= decision_timestamp)
    AND (started_at IS NULL OR (confirmed_at IS NOT NULL AND started_at >= confirmed_at))
    AND (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at))
  ),
  CONSTRAINT turniq_assignment_lifecycle_truth_check CHECK (
    (status = 'recommended' AND confirmation_kind IS NULL
      AND confirmation_actor_user_id IS NULL AND override_reason IS NULL
      AND confirmed_at IS NULL AND started_at IS NULL
      AND completed_at IS NULL AND NOT turn_consumed)
    OR (status = 'confirmed' AND confirmation_kind IS NOT NULL
      AND confirmation_actor_user_id IS NOT NULL
      AND confirmed_at IS NOT NULL AND started_at IS NULL
      AND completed_at IS NULL AND NOT turn_consumed)
    OR (status = 'in_progress' AND confirmation_kind IS NOT NULL
      AND confirmation_actor_user_id IS NOT NULL
      AND confirmed_at IS NOT NULL AND started_at IS NOT NULL
      AND completed_at IS NULL AND NOT turn_consumed)
    OR (status = 'completed' AND confirmation_kind IS NOT NULL
      AND confirmation_actor_user_id IS NOT NULL
      AND confirmed_at IS NOT NULL AND started_at IS NOT NULL
      AND completed_at IS NOT NULL AND turn_consumed)
    OR (status IN ('cancelled', 'rejected') AND completed_at IS NULL
      AND NOT turn_consumed)
  ),
  CONSTRAINT turniq_assignment_override_reason_check CHECK (
    (confirmation_kind IS NULL AND confirmation_actor_user_id IS NULL
      AND override_reason IS NULL)
    OR (confirmation_kind = 'confirmed_recommendation'
      AND confirmation_actor_user_id IS NOT NULL AND override_reason IS NULL)
    OR (confirmation_kind = 'override'
      AND confirmation_actor_user_id IS NOT NULL
      AND coalesce(length(btrim(override_reason)), 0) BETWEEN 1 AND 500)
  ),
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, shift_session_id)
    REFERENCES public.turniq_shift_sessions(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, customer_request_id),
  UNIQUE (salon_id, id)
);

CREATE INDEX turniq_assignment_active_idx
  ON public.turniq_assignments (salon_id, status, decision_timestamp DESC)
  WHERE status IN ('recommended', 'confirmed', 'in_progress');
CREATE INDEX turniq_assignment_booking_idx
  ON public.turniq_assignments (salon_id, booking_id)
  WHERE booking_id IS NOT NULL;
CREATE INDEX turniq_assignment_group_idx
  ON public.turniq_assignments (salon_id, assignment_group_id)
  WHERE assignment_group_id IS NOT NULL;
CREATE INDEX turniq_assignment_assigned_staff_idx
  ON public.turniq_assignments (salon_id, assigned_staff_id, status)
  WHERE assigned_staff_id IS NOT NULL;
CREATE INDEX turniq_assignment_shift_fk_idx
  ON public.turniq_assignments (salon_id, shift_session_id)
  WHERE shift_session_id IS NOT NULL;

CREATE TABLE public.turniq_command_receipts (
  command_id uuid PRIMARY KEY,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  policy_version_id uuid NOT NULL,
  device_id uuid NOT NULL,
  local_sequence bigint NOT NULL CHECK (local_sequence > 0),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role text NOT NULL CHECK (
    actor_role IN ('owner', 'admin', 'senior', 'receptionist', 'nail_tech', 'system')
  ),
  command_type text NOT NULL CHECK (
    command_type IN (
      'check_in', 'check_out', 'break', 'return', 'hold', 'release_hold',
      'recommend', 'confirm', 'override', 'start', 'complete',
      'add_service', 'swap', 'refuse', 'redo', 'dispute', 'resolve_dispute'
    )
  ),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result_fingerprint text NOT NULL CHECK (result_fingerprint ~ '^[0-9a-f]{64}$'),
  result_status text NOT NULL
    CHECK (result_status IN ('committed', 'rejected', 'conflict')),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  client_timestamp timestamptz NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT turniq_command_actor_check CHECK (
    (actor_role = 'system' AND actor_user_id IS NULL)
    OR (actor_role <> 'system' AND actor_user_id IS NOT NULL)
  ),
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, command_id),
  UNIQUE (salon_id, device_id, local_sequence)
);

CREATE INDEX turniq_command_committed_idx
  ON public.turniq_command_receipts (salon_id, committed_at DESC);
CREATE INDEX turniq_command_policy_fk_idx
  ON public.turniq_command_receipts (salon_id, policy_version_id);

CREATE TABLE public.turniq_events (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  policy_version_id uuid NOT NULL,
  assignment_id uuid,
  command_id uuid,
  aggregate_type text NOT NULL CHECK (
    aggregate_type IN ('policy', 'shift', 'assignment', 'exception', 'dispute', 'device')
  ),
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  event_type text NOT NULL
    CHECK (length(btrim(event_type)) BETWEEN 1 AND 120),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_staff_id uuid REFERENCES public.staff(id) ON DELETE RESTRICT,
  actor_role text NOT NULL CHECK (
    actor_role IN ('owner', 'admin', 'senior', 'receptionist', 'nail_tech', 'customer', 'system')
  ),
  actor_ref text NOT NULL CHECK (length(btrim(actor_ref)) BETWEEN 1 AND 200),
  reason_code text,
  reason_detail text,
  decision_fingerprint text CHECK (
    decision_fingerprint IS NULL OR decision_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  request_fingerprint text CHECK (
    request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, assignment_id)
    REFERENCES public.turniq_assignments(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, command_id)
    REFERENCES public.turniq_command_receipts(salon_id, command_id) ON DELETE RESTRICT,
  UNIQUE (salon_id, id),
  UNIQUE (salon_id, aggregate_type, aggregate_id, aggregate_version)
);

CREATE INDEX turniq_event_assignment_history_idx
  ON public.turniq_events (salon_id, assignment_id, occurred_at, id)
  WHERE assignment_id IS NOT NULL;
CREATE INDEX turniq_event_aggregate_history_idx
  ON public.turniq_events
    (salon_id, aggregate_type, aggregate_id, aggregate_version);
CREATE INDEX turniq_event_command_fk_idx
  ON public.turniq_events (salon_id, command_id)
  WHERE command_id IS NOT NULL;

CREATE TABLE public.turniq_fairness_receipts (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  policy_version_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  command_id uuid NOT NULL,
  recommended_staff_id uuid REFERENCES public.staff(id) ON DELETE RESTRICT,
  assigned_staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  service_id uuid REFERENCES public.services(id) ON DELETE RESTRICT,
  resource_id uuid REFERENCES public.salon_resources(id) ON DELETE RESTRICT,
  requested_tech_source text CHECK (
    requested_tech_source IS NULL OR requested_tech_source IN (
      'customer_selected', 'ai_confirmed', 'staff_entered', 'in_person',
      'imported', 'override', 'legacy_unknown'
    )
  ),
  request_trust_label text CHECK (
    request_trust_label IS NULL OR request_trust_label IN (
      'customer_confirmed', 'customer_claim_recorded',
      'imported_unverified', 'manager_override', 'legacy_unknown'
    )
  ),
  privacy_safe_explanation text NOT NULL
    CHECK (length(btrim(privacy_safe_explanation)) BETWEEN 1 AND 500),
  skipped_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(skipped_reason_codes) = 'array'),
  fairness_band_cents integer NOT NULL CHECK (fairness_band_cents BETWEEN 0 AND 10000),
  decision_fingerprint text NOT NULL CHECK (decision_fingerprint ~ '^[0-9a-f]{64}$'),
  command_fingerprint text NOT NULL CHECK (command_fingerprint ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role text NOT NULL CHECK (
    actor_role IN ('owner', 'admin', 'senior', 'receptionist', 'nail_tech', 'system')
  ),
  assignment_outcome text NOT NULL CHECK (
    assignment_outcome IN ('confirmed_recommendation', 'override')
  ),
  override_reason text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT turniq_receipt_actor_check CHECK (
    (actor_role = 'system' AND actor_user_id IS NULL)
    OR (actor_role <> 'system' AND actor_user_id IS NOT NULL)
  ),
  CONSTRAINT turniq_receipt_override_reason_check CHECK (
    (assignment_outcome = 'confirmed_recommendation' AND override_reason IS NULL)
    OR (assignment_outcome = 'override'
      AND coalesce(length(btrim(override_reason)), 0) BETWEEN 1 AND 500)
  ),
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, assignment_id)
    REFERENCES public.turniq_assignments(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, command_id)
    REFERENCES public.turniq_command_receipts(salon_id, command_id) ON DELETE RESTRICT,
  UNIQUE (salon_id, assignment_id),
  UNIQUE (salon_id, id)
);

CREATE INDEX turniq_receipt_staff_idx
  ON public.turniq_fairness_receipts (salon_id, assigned_staff_id, created_at DESC);
CREATE INDEX turniq_receipt_policy_fk_idx
  ON public.turniq_fairness_receipts (salon_id, policy_version_id);
CREATE INDEX turniq_receipt_command_fk_idx
  ON public.turniq_fairness_receipts (salon_id, command_id);

CREATE TABLE public.turniq_exceptions (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  policy_version_id uuid NOT NULL,
  assignment_id uuid,
  exception_type text NOT NULL CHECK (
    exception_type IN (
      'unsafe_assignment', 'impossible_assignment', 'self_assignment_override',
      'staff_dispute', 'request_pattern_review', 'stale_policy',
      'stale_snapshot', 'offline_conflict', 'duplicate_command',
      'appointment_risk', 'resource_risk'
    )
  ),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  privacy_safe_summary text NOT NULL
    CHECK (length(btrim(privacy_safe_summary)) BETWEEN 1 AND 500),
  recommended_action text NOT NULL
    CHECK (length(btrim(recommended_action)) BETWEEN 1 AND 500),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  resolved_at timestamptz,
  resolved_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  resolution_reason text,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT turniq_exception_resolution_check CHECK (
    (status IN ('open', 'acknowledged') AND resolved_at IS NULL
      AND resolved_by_user_id IS NULL AND resolution_reason IS NULL)
    OR (status IN ('resolved', 'dismissed') AND resolved_at IS NOT NULL
      AND resolved_by_user_id IS NOT NULL
      AND coalesce(length(btrim(resolution_reason)), 0) BETWEEN 1 AND 500)
  ),
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, assignment_id)
    REFERENCES public.turniq_assignments(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, id)
);

CREATE INDEX turniq_exception_inbox_idx
  ON public.turniq_exceptions (salon_id, status, created_at)
  WHERE status IN ('open', 'acknowledged');
CREATE INDEX turniq_exception_assignment_fk_idx
  ON public.turniq_exceptions (salon_id, assignment_id)
  WHERE assignment_id IS NOT NULL;

CREATE TABLE public.turniq_disputes (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  policy_version_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  fairness_receipt_id uuid NOT NULL,
  raised_by_staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  category text NOT NULL CHECK (
    category IN ('assignment', 'skip_reason', 'turn_credit', 'service_credit', 'override', 'other')
  ),
  privacy_safe_reason text NOT NULL
    CHECK (length(btrim(privacy_safe_reason)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'under_review', 'resolved', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  resolved_at timestamptz,
  resolved_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  resolution_reason text,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT turniq_dispute_resolution_check CHECK (
    (status IN ('open', 'under_review') AND resolved_at IS NULL
      AND resolved_by_user_id IS NULL AND resolution_reason IS NULL)
    OR (status IN ('resolved', 'dismissed') AND resolved_at IS NOT NULL
      AND resolved_by_user_id IS NOT NULL
      AND coalesce(length(btrim(resolution_reason)), 0) BETWEEN 1 AND 500)
  ),
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, assignment_id)
    REFERENCES public.turniq_assignments(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, fairness_receipt_id)
    REFERENCES public.turniq_fairness_receipts(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, id)
);

CREATE INDEX turniq_dispute_open_idx
  ON public.turniq_disputes (salon_id, status, created_at)
  WHERE status IN ('open', 'under_review');
CREATE INDEX turniq_dispute_assignment_fk_idx
  ON public.turniq_disputes (salon_id, assignment_id);
CREATE INDEX turniq_dispute_receipt_fk_idx
  ON public.turniq_disputes (salon_id, fairness_receipt_id);
CREATE INDEX turniq_dispute_staff_fk_idx
  ON public.turniq_disputes (raised_by_staff_id);

CREATE OR REPLACE FUNCTION public.enforce_turniq_policy_effective_boundary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $enforce_turniq_policy_effective_boundary$
DECLARE
  v_salon_local_date date;
BEGIN
  v_salon_local_date :=
    (transaction_timestamp() AT TIME ZONE NEW.business_timezone)::date;

  IF NEW.emergency_same_day THEN
    IF NEW.effective_business_date <> v_salon_local_date THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Emergency TurnIQ policy must take effect today in salon timezone';
    END IF;
  ELSIF NEW.effective_business_date <= v_salon_local_date THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'TurnIQ policy changes take effect next salon-local business day';
  END IF;

  RETURN NEW;
END;
$enforce_turniq_policy_effective_boundary$;

REVOKE ALL ON FUNCTION public.enforce_turniq_policy_effective_boundary()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER enforce_turniq_policy_effective_boundary
  BEFORE INSERT ON public.turniq_policy_versions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_policy_effective_boundary();

-- Existing domain tables use globally unique UUID primary keys rather than
-- composite tenant keys. This service-only trigger makes the salon binding
-- explicit before any TurnIQ row can be written or re-linked.
CREATE OR REPLACE FUNCTION public.enforce_turniq_same_salon_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $enforce_turniq_same_salon_references$
BEGIN
  IF NEW.policy_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.turniq_policy_versions p
    WHERE p.id = NEW.policy_version_id AND p.salon_id = NEW.salon_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'TurnIQ policy does not belong to salon';
  END IF;

  IF TG_TABLE_NAME = 'turniq_shift_sessions' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.staff s
      WHERE s.id = NEW.staff_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ shift staff does not belong to salon';
    END IF;

  ELSIF TG_TABLE_NAME = 'turniq_assignments' THEN
    IF NEW.shift_session_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.turniq_shift_sessions sh
      WHERE sh.id = NEW.shift_session_id AND sh.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ shift does not belong to salon';
    END IF;
    IF NEW.booking_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = NEW.booking_id AND b.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ booking does not belong to salon';
    END IF;
    IF NEW.booking_segment_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.booking_service_segments bs
      WHERE bs.id = NEW.booking_segment_id
        AND bs.salon_id = NEW.salon_id
        AND (NEW.booking_id IS NULL OR bs.booking_id = NEW.booking_id)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ booking segment does not belong to salon or booking';
    END IF;
    IF NEW.recommended_staff_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff s
      WHERE s.id = NEW.recommended_staff_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ recommended staff does not belong to salon';
    END IF;
    IF NEW.assigned_staff_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff s
      WHERE s.id = NEW.assigned_staff_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ assigned staff does not belong to salon';
    END IF;
    IF NEW.requested_staff_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff s
      WHERE s.id = NEW.requested_staff_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ requested staff does not belong to salon';
    END IF;
    IF NEW.service_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.services sv
      WHERE sv.id = NEW.service_id AND sv.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ service does not belong to salon';
    END IF;
    IF NEW.resource_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.salon_resources r
      WHERE r.id = NEW.resource_id AND r.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ resource does not belong to salon';
    END IF;

  ELSIF TG_TABLE_NAME = 'turniq_events' THEN
    IF NEW.assignment_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.turniq_assignments a
      WHERE a.id = NEW.assignment_id AND a.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ event assignment does not belong to salon';
    END IF;
    IF NEW.actor_staff_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff s
      WHERE s.id = NEW.actor_staff_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ event actor staff does not belong to salon';
    END IF;

  ELSIF TG_TABLE_NAME = 'turniq_fairness_receipts' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.turniq_assignments a
      WHERE a.id = NEW.assignment_id AND a.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ receipt assignment does not belong to salon';
    END IF;
    IF NEW.recommended_staff_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff s
      WHERE s.id = NEW.recommended_staff_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ receipt recommended staff does not belong to salon';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.staff s
      WHERE s.id = NEW.assigned_staff_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ receipt assigned staff does not belong to salon';
    END IF;
    IF NEW.service_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.services sv
      WHERE sv.id = NEW.service_id AND sv.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ receipt service does not belong to salon';
    END IF;
    IF NEW.resource_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.salon_resources r
      WHERE r.id = NEW.resource_id AND r.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ receipt resource does not belong to salon';
    END IF;

  ELSIF TG_TABLE_NAME = 'turniq_exceptions' THEN
    IF NEW.assignment_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.turniq_assignments a
      WHERE a.id = NEW.assignment_id AND a.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ exception assignment does not belong to salon';
    END IF;

  ELSIF TG_TABLE_NAME = 'turniq_disputes' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.turniq_assignments a
      WHERE a.id = NEW.assignment_id AND a.salon_id = NEW.salon_id
    ) OR NOT EXISTS (
      SELECT 1 FROM public.turniq_fairness_receipts fr
      WHERE fr.id = NEW.fairness_receipt_id AND fr.salon_id = NEW.salon_id
    ) OR NOT EXISTS (
      SELECT 1 FROM public.staff s
      WHERE s.id = NEW.raised_by_staff_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ dispute reference does not belong to salon';
    END IF;
  END IF;

  RETURN NEW;
END;
$enforce_turniq_same_salon_references$;

REVOKE ALL ON FUNCTION public.enforce_turniq_same_salon_references()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER enforce_turniq_shift_same_salon
  BEFORE INSERT OR UPDATE ON public.turniq_shift_sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_same_salon_references();
CREATE TRIGGER enforce_turniq_assignment_same_salon
  BEFORE INSERT OR UPDATE ON public.turniq_assignments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_same_salon_references();
CREATE TRIGGER enforce_turniq_command_same_salon
  BEFORE INSERT OR UPDATE ON public.turniq_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_same_salon_references();
CREATE TRIGGER enforce_turniq_event_same_salon
  BEFORE INSERT OR UPDATE ON public.turniq_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_same_salon_references();
CREATE TRIGGER enforce_turniq_receipt_same_salon
  BEFORE INSERT OR UPDATE ON public.turniq_fairness_receipts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_same_salon_references();
CREATE TRIGGER enforce_turniq_exception_same_salon
  BEFORE INSERT OR UPDATE ON public.turniq_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_same_salon_references();
CREATE TRIGGER enforce_turniq_dispute_same_salon
  BEFORE INSERT OR UPDATE ON public.turniq_disputes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_same_salon_references();

CREATE OR REPLACE FUNCTION public.reject_turniq_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $reject_turniq_immutable_mutation$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = 'TurnIQ trust evidence is immutable';
END;
$reject_turniq_immutable_mutation$;

REVOKE ALL ON FUNCTION public.reject_turniq_immutable_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER reject_turniq_policy_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_policy_versions
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_immutable_mutation();
CREATE TRIGGER reject_turniq_command_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_immutable_mutation();
CREATE TRIGGER reject_turniq_event_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_immutable_mutation();
CREATE TRIGGER reject_turniq_receipt_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_fairness_receipts
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_immutable_mutation();

ALTER TABLE public.turniq_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_policy_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_shift_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_shift_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_command_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_fairness_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_fairness_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_exceptions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_disputes FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.turniq_policy_versions,
  public.turniq_shift_sessions,
  public.turniq_assignments,
  public.turniq_command_receipts,
  public.turniq_events,
  public.turniq_fairness_receipts,
  public.turniq_exceptions,
  public.turniq_disputes
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT ON TABLE
  public.turniq_policy_versions,
  public.turniq_command_receipts,
  public.turniq_events,
  public.turniq_fairness_receipts
TO service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE
  public.turniq_shift_sessions,
  public.turniq_assignments,
  public.turniq_exceptions,
  public.turniq_disputes
TO service_role;

COMMENT ON TABLE public.turniq_policy_versions IS
  'Immutable per-salon TurnIQ policy versions. New rules are new rows; same-day emergency changes require a reason.';
COMMENT ON TABLE public.turniq_events IS
  'Append-only authoritative TurnIQ domain ledger. Corrections append events and never rewrite history.';
COMMENT ON TABLE public.turniq_command_receipts IS
  'Immutable idempotency receipts for online and future primary-offline-device TurnIQ commands.';
COMMENT ON TABLE public.turniq_fairness_receipts IS
  'Immutable why-this-happened receipt for each confirmed or overridden TurnIQ assignment.';
COMMENT ON COLUMN public.turniq_assignments.opportunity_credit_cents IS
  'Fairness truth only: catalog/list price plus permitted add-ons, before tax and tip.';
COMMENT ON COLUMN public.turniq_assignments.actual_service_revenue_cents IS
  'Business truth kept separate from opportunity credit; never used by the V1 ranking engine.';

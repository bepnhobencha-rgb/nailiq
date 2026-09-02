-- TurnIQ M2 shadow/replay persistence.
--
-- This is append-only evidence behind the default-OFF TurnIQ flag. It adds no
-- booking/staff/resource trigger, no browser policy, and no live assignment
-- command. A shadow decision, its later actual comparison, and a replay run
-- are separate immutable facts so delayed observations never rewrite history.

CREATE TABLE public.turniq_shadow_decisions (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  policy_version_id uuid NOT NULL,
  engine_decision_id text NOT NULL
    CHECK (engine_decision_id ~ '^[A-Za-z0-9:_-]{1,160}$'),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9:_-]{1,160}$'),
  booking_id uuid REFERENCES public.bookings(id) ON DELETE RESTRICT,
  source text NOT NULL DEFAULT 'receptionist_center'
    CHECK (source = 'receptionist_center'),
  business_date date NOT NULL,
  observed_at timestamptz NOT NULL,
  snapshot_fingerprint text NOT NULL
    CHECK (snapshot_fingerprint ~ '^[0-9a-f]{64}$'),
  decision_fingerprint text NOT NULL
    CHECK (decision_fingerprint ~ '^[0-9a-f]{64}$'),
  observation_fingerprint text NOT NULL
    CHECK (observation_fingerprint ~ '^[0-9a-f]{64}$'),
  recommended_staff_id uuid REFERENCES public.staff(id) ON DELETE RESTRICT,
  privacy_safe_explanation text NOT NULL
    CHECK (length(btrim(privacy_safe_explanation)) BETWEEN 1 AND 500),
  decision_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(decision_reason_codes) = 'array'),
  eligible_candidate_count integer NOT NULL CHECK (eligible_candidate_count >= 0),
  skipped_candidate_count integer NOT NULL CHECK (skipped_candidate_count >= 0),
  decision_input jsonb NOT NULL CHECK (jsonb_typeof(decision_input) = 'object'),
  decision_output jsonb NOT NULL CHECK (jsonb_typeof(decision_output) = 'object'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, id),
  UNIQUE (salon_id, observation_fingerprint),
  UNIQUE (salon_id, decision_fingerprint, snapshot_fingerprint)
);

CREATE INDEX turniq_shadow_decision_business_date_idx
  ON public.turniq_shadow_decisions
    (salon_id, business_date, observed_at, id);
CREATE INDEX turniq_shadow_decision_booking_idx
  ON public.turniq_shadow_decisions (salon_id, booking_id)
  WHERE booking_id IS NOT NULL;
CREATE INDEX turniq_shadow_decision_policy_fk_idx
  ON public.turniq_shadow_decisions (salon_id, policy_version_id);

CREATE TABLE public.turniq_shadow_comparisons (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  shadow_decision_id uuid NOT NULL,
  actual_assigned_staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  actual_assigned_at timestamptz NOT NULL,
  customer_added_at timestamptz NOT NULL,
  comparison_outcome text NOT NULL CHECK (
    comparison_outcome IN (
      'matched_recommendation', 'explained_divergence', 'unexplained_divergence',
      'actual_assignee_ineligible', 'no_safe_recommendation'
    )
  ),
  divergence_reason text CHECK (
    divergence_reason IS NULL OR divergence_reason IN (
      'customer_rejected_recommendation', 'requested_technician_honored',
      'operational_exception', 'manager_override', 'staff_override'
    )
  ),
  owner_intervened boolean NOT NULL DEFAULT false,
  assignment_latency_seconds integer NOT NULL
    CHECK (assignment_latency_seconds >= 0),
  privacy_safe_summary text NOT NULL
    CHECK (length(btrim(privacy_safe_summary)) BETWEEN 1 AND 500),
  comparison_fingerprint text NOT NULL
    CHECK (comparison_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT turniq_shadow_actual_assignment_check CHECK (
    actual_assigned_at >= customer_added_at
  ),
  CONSTRAINT turniq_shadow_divergence_reason_check CHECK (
    (comparison_outcome = 'explained_divergence' AND divergence_reason IS NOT NULL)
    OR (comparison_outcome <> 'explained_divergence')
  ),
  FOREIGN KEY (salon_id, shadow_decision_id)
    REFERENCES public.turniq_shadow_decisions(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, id),
  UNIQUE (salon_id, shadow_decision_id),
  UNIQUE (salon_id, comparison_fingerprint)
);

CREATE INDEX turniq_shadow_comparison_outcome_idx
  ON public.turniq_shadow_comparisons
    (salon_id, comparison_outcome, created_at);
CREATE INDEX turniq_shadow_comparison_staff_idx
  ON public.turniq_shadow_comparisons
    (salon_id, actual_assigned_staff_id, created_at)
  WHERE actual_assigned_staff_id IS NOT NULL;

CREATE TABLE public.turniq_replay_runs (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  current_policy_version_id uuid NOT NULL,
  proposed_policy_version_id uuid NOT NULL,
  from_business_date date NOT NULL,
  through_business_date date NOT NULL,
  case_count integer NOT NULL CHECK (case_count >= 0),
  current_metrics jsonb NOT NULL CHECK (jsonb_typeof(current_metrics) = 'object'),
  proposed_metrics jsonb NOT NULL CHECK (jsonb_typeof(proposed_metrics) = 'object'),
  input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  result_fingerprint text NOT NULL CHECK (result_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  read_only boolean NOT NULL DEFAULT true CHECK (read_only),
  CONSTRAINT turniq_replay_date_range_check CHECK (
    from_business_date <= through_business_date
  ),
  FOREIGN KEY (salon_id, current_policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, proposed_policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, id),
  UNIQUE (salon_id, result_fingerprint)
);

CREATE INDEX turniq_replay_run_date_idx
  ON public.turniq_replay_runs
    (salon_id, from_business_date, through_business_date, created_at DESC);
CREATE INDEX turniq_replay_current_policy_fk_idx
  ON public.turniq_replay_runs (salon_id, current_policy_version_id);
CREATE INDEX turniq_replay_proposed_policy_fk_idx
  ON public.turniq_replay_runs (salon_id, proposed_policy_version_id);

CREATE TABLE public.turniq_replay_cases (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  replay_run_id uuid NOT NULL,
  shadow_decision_id uuid,
  case_id text NOT NULL CHECK (case_id ~ '^[A-Za-z0-9:_-]{1,160}$'),
  business_date date NOT NULL,
  current_recommended_staff_id uuid REFERENCES public.staff(id) ON DELETE RESTRICT,
  proposed_recommended_staff_id uuid REFERENCES public.staff(id) ON DELETE RESTRICT,
  current_decision_fingerprint text NOT NULL
    CHECK (current_decision_fingerprint ~ '^[0-9a-f]{64}$'),
  proposed_decision_fingerprint text NOT NULL
    CHECK (proposed_decision_fingerprint ~ '^[0-9a-f]{64}$'),
  recommendation_changed boolean NOT NULL,
  current_comparison jsonb NOT NULL CHECK (jsonb_typeof(current_comparison) = 'object'),
  proposed_comparison jsonb NOT NULL CHECK (jsonb_typeof(proposed_comparison) = 'object'),
  case_result_fingerprint text NOT NULL
    CHECK (case_result_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (salon_id, replay_run_id)
    REFERENCES public.turniq_replay_runs(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, shadow_decision_id)
    REFERENCES public.turniq_shadow_decisions(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, id),
  UNIQUE (salon_id, replay_run_id, case_id),
  UNIQUE (salon_id, replay_run_id, case_result_fingerprint)
);

CREATE INDEX turniq_replay_case_run_idx
  ON public.turniq_replay_cases (salon_id, replay_run_id, case_id);
CREATE INDEX turniq_replay_case_shadow_idx
  ON public.turniq_replay_cases (salon_id, shadow_decision_id)
  WHERE shadow_decision_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_turniq_shadow_replay_same_salon()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $enforce_turniq_shadow_replay_same_salon$
BEGIN
  IF TG_TABLE_NAME = 'turniq_shadow_decisions' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.turniq_policy_versions p
      WHERE p.id = NEW.policy_version_id AND p.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ shadow policy does not belong to salon';
    END IF;
    IF NEW.booking_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = NEW.booking_id AND b.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ shadow booking does not belong to salon';
    END IF;
    IF NEW.recommended_staff_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff s
      WHERE s.id = NEW.recommended_staff_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ shadow recommended staff does not belong to salon';
    END IF;

  ELSIF TG_TABLE_NAME = 'turniq_shadow_comparisons' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.turniq_shadow_decisions d
      WHERE d.id = NEW.shadow_decision_id AND d.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ comparison decision does not belong to salon';
    END IF;
    IF NEW.actual_assigned_staff_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff s
      WHERE s.id = NEW.actual_assigned_staff_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ comparison staff does not belong to salon';
    END IF;

  ELSIF TG_TABLE_NAME = 'turniq_replay_runs' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.turniq_policy_versions p
      WHERE p.id = NEW.current_policy_version_id AND p.salon_id = NEW.salon_id
    ) OR NOT EXISTS (
      SELECT 1 FROM public.turniq_policy_versions p
      WHERE p.id = NEW.proposed_policy_version_id AND p.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ replay policy does not belong to salon';
    END IF;

  ELSIF TG_TABLE_NAME = 'turniq_replay_cases' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.turniq_replay_runs r
      WHERE r.id = NEW.replay_run_id AND r.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ replay run does not belong to salon';
    END IF;
    IF NEW.shadow_decision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.turniq_shadow_decisions d
      WHERE d.id = NEW.shadow_decision_id AND d.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ replay decision does not belong to salon';
    END IF;
    IF NEW.current_recommended_staff_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff s
      WHERE s.id = NEW.current_recommended_staff_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ replay current staff does not belong to salon';
    END IF;
    IF NEW.proposed_recommended_staff_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff s
      WHERE s.id = NEW.proposed_recommended_staff_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ replay proposed staff does not belong to salon';
    END IF;
  END IF;
  RETURN NEW;
END;
$enforce_turniq_shadow_replay_same_salon$;

REVOKE ALL ON FUNCTION public.enforce_turniq_shadow_replay_same_salon()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER enforce_turniq_shadow_decision_same_salon
  BEFORE INSERT ON public.turniq_shadow_decisions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_shadow_replay_same_salon();
CREATE TRIGGER enforce_turniq_shadow_comparison_same_salon
  BEFORE INSERT ON public.turniq_shadow_comparisons
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_shadow_replay_same_salon();
CREATE TRIGGER enforce_turniq_replay_run_same_salon
  BEFORE INSERT ON public.turniq_replay_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_shadow_replay_same_salon();
CREATE TRIGGER enforce_turniq_replay_case_same_salon
  BEFORE INSERT ON public.turniq_replay_cases
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_shadow_replay_same_salon();

CREATE OR REPLACE FUNCTION public.reject_turniq_shadow_replay_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $reject_turniq_shadow_replay_mutation$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = 'TurnIQ shadow and replay evidence is immutable';
END;
$reject_turniq_shadow_replay_mutation$;

REVOKE ALL ON FUNCTION public.reject_turniq_shadow_replay_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER reject_turniq_shadow_decision_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_shadow_decisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_shadow_replay_mutation();
CREATE TRIGGER reject_turniq_shadow_comparison_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_shadow_comparisons
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_shadow_replay_mutation();
CREATE TRIGGER reject_turniq_replay_run_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_replay_runs
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_shadow_replay_mutation();
CREATE TRIGGER reject_turniq_replay_case_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_replay_cases
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_shadow_replay_mutation();

ALTER TABLE public.turniq_shadow_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_shadow_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_shadow_comparisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_shadow_comparisons FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_replay_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_replay_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_replay_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_replay_cases FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.turniq_shadow_decisions,
  public.turniq_shadow_comparisons,
  public.turniq_replay_runs,
  public.turniq_replay_cases
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT ON TABLE
  public.turniq_shadow_decisions,
  public.turniq_shadow_comparisons,
  public.turniq_replay_runs,
  public.turniq_replay_cases
TO service_role;

COMMENT ON TABLE public.turniq_shadow_decisions IS
  'PII-minimized immutable TurnIQ recommendations captured without changing live salon state.';
COMMENT ON TABLE public.turniq_shadow_comparisons IS
  'Immutable comparison with the later human assignment. No row means assignment is still pending.';
COMMENT ON TABLE public.turniq_replay_runs IS
  'Read-only deterministic current-versus-proposed policy simulation; never mutates historical or live records.';
COMMENT ON COLUMN public.turniq_shadow_decisions.decision_input IS
  'Private replay material only; must exclude customer name, phone, email, notes, tips, and provider data.';

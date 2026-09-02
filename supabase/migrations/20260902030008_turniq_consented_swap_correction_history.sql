-- TurnIQ M3H3: consented pre-service swaps and append-only correction history.
--
-- A swap may be proposed only for a confirmed assignment that has not started.
-- Both affected technicians consent for themselves; a desk user then applies
-- the transfer atomically to the booking and TurnIQ assignment. A completed
-- assignment may be corrected only by Owner/Admin. The original Fairness
-- Receipt is never rewritten; turn and opportunity credit move to the shift of
-- the technician who actually performed the work and an immutable correction
-- records before/after truth.
--
-- This remains inert while turniq_trust_engine_enabled is false. Rollback is
-- to keep the flag OFF and stop invoking these service-only RPCs. Preserve all
-- swap, consent, correction, receipt and event rows as audit evidence.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.turniq_command_receipts
  DROP CONSTRAINT turniq_command_receipts_command_type_check;
ALTER TABLE public.turniq_command_receipts
  ADD CONSTRAINT turniq_command_receipts_command_type_check CHECK (
    command_type IN (
      'check_in', 'check_out', 'break', 'return', 'hold', 'release_hold',
      'recommend', 'confirm', 'override', 'start', 'complete',
      'add_service', 'swap', 'correction', 'refuse', 'redo', 'dispute',
      'resolve_dispute', 'acknowledge_exception', 'resolve_exception',
      'dismiss_exception'
    )
  );

CREATE TABLE public.turniq_assignment_swaps (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  policy_version_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  from_staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  to_staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending_consents' CHECK (
    status IN ('pending_consents', 'ready', 'applied', 'rejected')
  ),
  requested_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  applied_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL,
  applied_at timestamptz,
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT turniq_swap_distinct_staff_check CHECK (from_staff_id <> to_staff_id),
  CONSTRAINT turniq_swap_applied_truth_check CHECK (
    (status <> 'applied' AND applied_by_user_id IS NULL AND applied_at IS NULL)
    OR (status = 'applied' AND applied_by_user_id IS NOT NULL
      AND applied_at IS NOT NULL AND applied_at >= requested_at)
  ),
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, assignment_id)
    REFERENCES public.turniq_assignments(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, id)
);

CREATE UNIQUE INDEX turniq_swap_one_open_assignment_idx
  ON public.turniq_assignment_swaps (salon_id, assignment_id)
  WHERE status IN ('pending_consents', 'ready');
CREATE INDEX turniq_swap_from_staff_status_idx
  ON public.turniq_assignment_swaps
    (from_staff_id, salon_id, status, requested_at DESC);
CREATE INDEX turniq_swap_to_staff_status_idx
  ON public.turniq_assignment_swaps
    (to_staff_id, salon_id, status, requested_at DESC);
CREATE INDEX turniq_swap_policy_fk_idx
  ON public.turniq_assignment_swaps (salon_id, policy_version_id);
CREATE INDEX turniq_swap_requested_by_fk_idx
  ON public.turniq_assignment_swaps (requested_by_user_id);
CREATE INDEX turniq_swap_applied_by_fk_idx
  ON public.turniq_assignment_swaps (applied_by_user_id)
  WHERE applied_by_user_id IS NOT NULL;

CREATE TABLE public.turniq_swap_consents (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  swap_id uuid NOT NULL,
  staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL,
  FOREIGN KEY (salon_id, swap_id)
    REFERENCES public.turniq_assignment_swaps(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, swap_id, staff_id),
  UNIQUE (salon_id, id)
);

CREATE INDEX turniq_swap_consent_staff_idx
  ON public.turniq_swap_consents (staff_id, salon_id, decided_at DESC);
CREATE INDEX turniq_swap_consent_actor_fk_idx
  ON public.turniq_swap_consents (actor_user_id);

CREATE TABLE public.turniq_assignment_corrections (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  policy_version_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  fairness_receipt_id uuid NOT NULL,
  correction_sequence integer NOT NULL CHECK (correction_sequence > 0),
  category text NOT NULL CHECK (
    category IN (
      'wrong_technician', 'missed_handoff', 'administrative_error', 'other'
    )
  ),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  previous_staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  actual_staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  previous_shift_session_id uuid NOT NULL,
  actual_shift_session_id uuid NOT NULL,
  turn_moved boolean NOT NULL,
  opportunity_credit_moved_cents integer NOT NULL
    CHECK (opportunity_credit_moved_cents >= 0),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  corrected_at timestamptz NOT NULL,
  CONSTRAINT turniq_correction_distinct_staff_check
    CHECK (previous_staff_id <> actual_staff_id),
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, assignment_id)
    REFERENCES public.turniq_assignments(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, fairness_receipt_id)
    REFERENCES public.turniq_fairness_receipts(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, previous_shift_session_id)
    REFERENCES public.turniq_shift_sessions(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, actual_shift_session_id)
    REFERENCES public.turniq_shift_sessions(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, assignment_id, correction_sequence),
  UNIQUE (salon_id, id)
);

CREATE INDEX turniq_correction_assignment_history_idx
  ON public.turniq_assignment_corrections
    (salon_id, assignment_id, correction_sequence);
CREATE INDEX turniq_correction_staff_history_idx
  ON public.turniq_assignment_corrections
    (previous_staff_id, salon_id, corrected_at DESC);
CREATE INDEX turniq_correction_actual_staff_history_idx
  ON public.turniq_assignment_corrections
    (actual_staff_id, salon_id, corrected_at DESC);
CREATE INDEX turniq_correction_receipt_fk_idx
  ON public.turniq_assignment_corrections (salon_id, fairness_receipt_id);
CREATE INDEX turniq_correction_policy_fk_idx
  ON public.turniq_assignment_corrections (salon_id, policy_version_id);
CREATE INDEX turniq_correction_previous_shift_fk_idx
  ON public.turniq_assignment_corrections
    (previous_shift_session_id, salon_id);
CREATE INDEX turniq_correction_actual_shift_fk_idx
  ON public.turniq_assignment_corrections
    (actual_shift_session_id, salon_id);
CREATE INDEX turniq_correction_actor_fk_idx
  ON public.turniq_assignment_corrections (actor_user_id);

ALTER TABLE public.turniq_assignment_swaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_assignment_swaps FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_swap_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_swap_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_assignment_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_assignment_corrections FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.turniq_assignment_swaps,
  public.turniq_swap_consents, public.turniq_assignment_corrections
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.turniq_assignment_swaps
  TO service_role;
GRANT SELECT, INSERT ON TABLE public.turniq_swap_consents,
  public.turniq_assignment_corrections TO service_role;

CREATE TRIGGER reject_turniq_swap_consent_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_swap_consents
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_immutable_mutation();
CREATE TRIGGER reject_turniq_assignment_correction_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_assignment_corrections
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_immutable_mutation();

CREATE OR REPLACE FUNCTION public.guard_turniq_swap_request_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ swap history is append-preserving';
  END IF;
  IF OLD.salon_id IS DISTINCT FROM NEW.salon_id
     OR OLD.policy_version_id IS DISTINCT FROM NEW.policy_version_id
     OR OLD.assignment_id IS DISTINCT FROM NEW.assignment_id
     OR OLD.from_staff_id IS DISTINCT FROM NEW.from_staff_id
     OR OLD.to_staff_id IS DISTINCT FROM NEW.to_staff_id
     OR OLD.reason IS DISTINCT FROM NEW.reason
     OR OLD.requested_by_user_id IS DISTINCT FROM NEW.requested_by_user_id
     OR OLD.requested_at IS DISTINCT FROM NEW.requested_at
     OR NEW.state_version <> OLD.state_version + 1
     OR OLD.status IN ('applied', 'rejected')
     OR (OLD.status = 'pending_consents'
       AND NEW.status NOT IN ('pending_consents', 'ready', 'rejected'))
     OR (OLD.status = 'ready' AND NEW.status NOT IN ('applied', 'rejected')) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'invalid TurnIQ swap history mutation';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.guard_turniq_swap_request_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER guard_turniq_swap_request_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_assignment_swaps
  FOR EACH ROW EXECUTE FUNCTION public.guard_turniq_swap_request_mutation();

CREATE OR REPLACE FUNCTION public.guard_turniq_pending_swap_start()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
BEGIN
  IF OLD.status = 'confirmed' AND NEW.status = 'in_progress'
     AND EXISTS (
       SELECT 1 FROM public.turniq_assignment_swaps AS s
       WHERE s.salon_id = OLD.salon_id
         AND s.assignment_id = OLD.id
         AND s.status IN ('pending_consents', 'ready')
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'pending TurnIQ swap must be applied or rejected before start';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.guard_turniq_pending_swap_start()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER guard_turniq_pending_swap_start
  BEFORE UPDATE ON public.turniq_assignments
  FOR EACH ROW EXECUTE FUNCTION public.guard_turniq_pending_swap_start();

CREATE OR REPLACE FUNCTION public.apply_turniq_swap_command_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_assignment_id uuid,
  p_swap_id uuid,
  p_command_type text,
  p_to_staff_id uuid,
  p_consent_decision text,
  p_reason text,
  p_command_id uuid,
  p_device_id uuid,
  p_local_sequence bigint,
  p_actor_user_id uuid,
  p_actor_role text,
  p_request_fingerprint text,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_context jsonb;
  v_replay jsonb;
  v_assignment public.turniq_assignments%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_swap public.turniq_assignment_swaps%ROWTYPE;
  v_from_shift public.turniq_shift_sessions%ROWTYPE;
  v_to_shift public.turniq_shift_sessions%ROWTYPE;
  v_actor_staff_id uuid;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_event_version bigint;
  v_accept_count integer;
  v_result jsonb;
BEGIN
  IF p_command_id IS NULL OR p_device_id IS NULL OR p_local_sequence <= 0
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_command_type NOT IN ('request_swap', 'consent_swap', 'confirm_swap')
     OR (p_command_type = 'request_swap' AND (
       p_assignment_id IS NULL OR p_swap_id IS NOT NULL OR p_to_staff_id IS NULL
       OR v_reason IS NULL OR length(v_reason) > 500
       OR p_consent_decision IS NOT NULL
     ))
     OR (p_command_type = 'consent_swap' AND (
       p_swap_id IS NULL OR p_assignment_id IS NOT NULL OR p_to_staff_id IS NOT NULL
       OR p_consent_decision NOT IN ('accepted', 'rejected') OR p_reason IS NOT NULL
     ))
     OR (p_command_type = 'confirm_swap' AND (
       p_swap_id IS NULL OR p_assignment_id IS NOT NULL OR p_to_staff_id IS NOT NULL
       OR p_consent_decision IS NOT NULL OR p_reason IS NOT NULL
     )) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ swap command';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  v_replay := public.turniq_replay_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
    p_actor_role, 'swap', p_request_fingerprint
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role, p_occurred_at
  );
  v_actor_staff_id := nullif(v_context ->> 'actor_staff_id', '')::uuid;

  IF p_command_type = 'request_swap' THEN
    SELECT a.* INTO v_assignment
    FROM public.turniq_assignments AS a
    WHERE a.salon_id = p_salon_id AND a.id = p_assignment_id
    FOR UPDATE;
    IF NOT FOUND OR v_assignment.policy_version_id IS DISTINCT FROM p_policy_version_id
       OR v_assignment.status <> 'confirmed' OR v_assignment.started_at IS NOT NULL
       OR v_assignment.assigned_staff_id IS NULL
       OR v_assignment.assigned_staff_id = p_to_staff_id THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ assignment is not available for a pre-service swap';
    END IF;
    IF p_actor_role = 'nail_tech' AND (
      v_actor_staff_id IS NULL OR v_actor_staff_id NOT IN (
        v_assignment.assigned_staff_id, p_to_staff_id
      )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'technician may propose only an affected TurnIQ swap';
    END IF;

    PERFORM 1 FROM public.staff AS st
    WHERE st.salon_id = p_salon_id AND st.id = p_to_staff_id
      AND st.status = 'active' AND st.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'proposed technician is unavailable';
    END IF;

    PERFORM 1
    FROM public.turniq_shift_sessions AS sh
    WHERE sh.salon_id = p_salon_id
      AND sh.policy_version_id = p_policy_version_id
      AND sh.business_date = (v_context ->> 'business_date')::date
      AND sh.staff_id IN (v_assignment.assigned_staff_id, p_to_staff_id)
    ORDER BY sh.id
    FOR UPDATE;
    SELECT sh.* INTO v_from_shift
    FROM public.turniq_shift_sessions AS sh
    WHERE sh.id = v_assignment.shift_session_id AND sh.salon_id = p_salon_id
      AND sh.policy_version_id = p_policy_version_id
      AND sh.business_date = (v_context ->> 'business_date')::date
      AND sh.staff_id = v_assignment.assigned_staff_id
      AND sh.state = 'active' AND sh.checked_out_at IS NULL;
    SELECT sh.* INTO v_to_shift
    FROM public.turniq_shift_sessions AS sh
    WHERE sh.salon_id = p_salon_id AND sh.policy_version_id = p_policy_version_id
      AND sh.business_date = (v_context ->> 'business_date')::date
      AND sh.staff_id = p_to_staff_id AND sh.state = 'active'
      AND sh.checked_out_at IS NULL;
    IF v_from_shift.id IS NULL OR v_to_shift.id IS NULL OR EXISTS (
      SELECT 1 FROM public.turniq_assignments AS busy
      WHERE busy.salon_id = p_salon_id
        AND busy.assigned_staff_id = p_to_staff_id
        AND busy.id <> p_assignment_id
        AND busy.status IN ('confirmed', 'in_progress')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'both technicians must be active and the proposed technician free';
    END IF;

    INSERT INTO public.turniq_assignment_swaps (
      salon_id, policy_version_id, assignment_id, from_staff_id, to_staff_id,
      reason, requested_by_user_id, requested_at
    ) VALUES (
      p_salon_id, p_policy_version_id, p_assignment_id,
      v_assignment.assigned_staff_id, p_to_staff_id, v_reason,
      p_actor_user_id, p_occurred_at
    ) RETURNING * INTO v_swap;
  ELSE
    SELECT s.* INTO v_swap
    FROM public.turniq_assignment_swaps AS s
    WHERE s.salon_id = p_salon_id AND s.id = p_swap_id
    FOR UPDATE;
    IF NOT FOUND OR v_swap.policy_version_id IS DISTINCT FROM p_policy_version_id
       OR v_swap.status NOT IN ('pending_consents', 'ready') THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ swap is unavailable or stale';
    END IF;

    IF p_command_type = 'consent_swap' THEN
      IF v_actor_staff_id IS NULL OR v_actor_staff_id NOT IN (
        v_swap.from_staff_id, v_swap.to_staff_id
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'only an affected technician may consent to this swap';
      END IF;
      INSERT INTO public.turniq_swap_consents (
        salon_id, swap_id, staff_id, decision, actor_user_id, decided_at
      ) VALUES (
        p_salon_id, v_swap.id, v_actor_staff_id, p_consent_decision,
        p_actor_user_id, p_occurred_at
      );
      IF p_consent_decision = 'rejected' THEN
        UPDATE public.turniq_assignment_swaps AS s
        SET status = 'rejected', state_version = s.state_version + 1,
            updated_at = pg_catalog.transaction_timestamp()
        WHERE s.id = v_swap.id AND s.state_version = v_swap.state_version
        RETURNING * INTO v_swap;
      ELSE
        SELECT count(*) INTO v_accept_count
        FROM public.turniq_swap_consents AS c
        WHERE c.salon_id = p_salon_id AND c.swap_id = v_swap.id
          AND c.decision = 'accepted';
        UPDATE public.turniq_assignment_swaps AS s
        SET status = CASE WHEN v_accept_count = 2 THEN 'ready'
              ELSE 'pending_consents' END,
            state_version = s.state_version + 1,
            updated_at = pg_catalog.transaction_timestamp()
        WHERE s.id = v_swap.id AND s.state_version = v_swap.state_version
        RETURNING * INTO v_swap;
      END IF;
    ELSE
      IF p_actor_role NOT IN ('owner', 'admin', 'senior', 'receptionist')
         OR v_swap.status <> 'ready'
         OR (SELECT count(*) FROM public.turniq_swap_consents AS c
             WHERE c.salon_id = p_salon_id AND c.swap_id = v_swap.id
               AND c.decision = 'accepted') <> 2 THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'TurnIQ swap requires two consents and desk confirmation';
      END IF;

      SELECT a.* INTO v_assignment
      FROM public.turniq_assignments AS a
      WHERE a.salon_id = p_salon_id AND a.id = v_swap.assignment_id
      FOR UPDATE;
      SELECT b.* INTO v_booking
      FROM public.bookings AS b
      WHERE b.salon_id = p_salon_id AND b.id = v_assignment.booking_id
      FOR UPDATE;
      PERFORM 1
      FROM public.turniq_shift_sessions AS sh
      WHERE sh.salon_id = p_salon_id
        AND sh.policy_version_id = p_policy_version_id
        AND sh.business_date = (v_context ->> 'business_date')::date
        AND sh.staff_id IN (v_swap.from_staff_id, v_swap.to_staff_id)
      ORDER BY sh.id
      FOR UPDATE;
      SELECT sh.* INTO v_from_shift
      FROM public.turniq_shift_sessions AS sh
      WHERE sh.id = v_assignment.shift_session_id AND sh.salon_id = p_salon_id
        AND sh.state = 'active' AND sh.checked_out_at IS NULL;
      SELECT sh.* INTO v_to_shift
      FROM public.turniq_shift_sessions AS sh
      WHERE sh.salon_id = p_salon_id AND sh.policy_version_id = p_policy_version_id
        AND sh.business_date = (v_context ->> 'business_date')::date
        AND sh.staff_id = v_swap.to_staff_id AND sh.state = 'active'
        AND sh.checked_out_at IS NULL;
      IF v_assignment.id IS NULL OR v_assignment.status <> 'confirmed'
         OR v_assignment.started_at IS NOT NULL
         OR v_assignment.assigned_staff_id IS DISTINCT FROM v_swap.from_staff_id
         OR v_booking.id IS NULL OR v_booking.status <> 'confirmed'
         OR v_booking.staff_id IS DISTINCT FROM v_swap.from_staff_id
         OR v_from_shift.id IS NULL OR v_to_shift.id IS NULL OR EXISTS (
           SELECT 1 FROM public.turniq_assignments AS busy
           WHERE busy.salon_id = p_salon_id
             AND busy.assigned_staff_id = v_swap.to_staff_id
             AND busy.id <> v_assignment.id
             AND busy.status IN ('confirmed', 'in_progress')
         ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
          MESSAGE = 'TurnIQ swap is no longer operationally safe';
      END IF;

      UPDATE public.turniq_assignment_swaps AS s
      SET status = 'applied', applied_by_user_id = p_actor_user_id,
          applied_at = p_occurred_at, state_version = s.state_version + 1,
          updated_at = pg_catalog.transaction_timestamp()
      WHERE s.id = v_swap.id AND s.state_version = v_swap.state_version
      RETURNING * INTO v_swap;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '40001',
          MESSAGE = 'TurnIQ swap changed concurrently';
      END IF;

      BEGIN
        UPDATE public.bookings AS b
        SET staff_id = v_swap.to_staff_id
        WHERE b.id = v_booking.id AND b.staff_id = v_swap.from_staff_id
          AND b.status = 'confirmed';
      EXCEPTION WHEN exclusion_violation OR unique_violation THEN
        RAISE EXCEPTION USING ERRCODE = '23P01',
          MESSAGE = 'TurnIQ swap conflicts with live capacity';
      END;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '40001',
          MESSAGE = 'TurnIQ booking changed concurrently';
      END IF;

      UPDATE public.turniq_assignments AS a
      SET assigned_staff_id = v_swap.to_staff_id,
          shift_session_id = v_to_shift.id,
          state_version = a.state_version + 1,
          updated_at = pg_catalog.transaction_timestamp()
      WHERE a.id = v_assignment.id AND a.state_version = v_assignment.state_version
      RETURNING * INTO v_assignment;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '40001',
          MESSAGE = 'TurnIQ assignment changed concurrently';
      END IF;
    END IF;
  END IF;

  SELECT coalesce(max(e.aggregate_version), 0) + 1 INTO v_event_version
  FROM public.turniq_events AS e
  WHERE e.salon_id = p_salon_id AND e.aggregate_type = 'assignment'
    AND e.aggregate_id = v_swap.assignment_id;
  v_result := pg_catalog.jsonb_build_object(
    'ok', true, 'command_id', p_command_id, 'replayed', false,
    'swap_id', v_swap.id, 'assignment_id', v_swap.assignment_id,
    'status', v_swap.status, 'state_version', v_swap.state_version,
    'from_staff_id', v_swap.from_staff_id, 'to_staff_id', v_swap.to_staff_id
  );
  PERFORM public.turniq_store_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, 'swap',
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );
  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
    aggregate_id, aggregate_version, event_type, actor_user_id, actor_staff_id,
    actor_role, actor_ref, reason_code, reason_detail, decision_fingerprint,
    request_fingerprint, payload, occurred_at
  )
  SELECT p_salon_id, p_policy_version_id, v_swap.assignment_id, p_command_id,
    'assignment', v_swap.assignment_id, v_event_version,
    CASE p_command_type WHEN 'request_swap' THEN 'swap_requested'
      WHEN 'consent_swap' THEN 'swap_consent_recorded'
      ELSE 'swap_applied' END,
    p_actor_user_id, v_actor_staff_id, p_actor_role,
    'user:' || p_actor_user_id::text,
    CASE WHEN p_command_type = 'consent_swap' THEN p_consent_decision
      ELSE p_command_type END,
    CASE WHEN p_command_type = 'request_swap' THEN v_swap.reason ELSE NULL END,
    a.decision_fingerprint, p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'swap_id', v_swap.id, 'status', v_swap.status,
      'state_version', v_swap.state_version,
      'from_staff_id', v_swap.from_staff_id, 'to_staff_id', v_swap.to_staff_id
    ), p_occurred_at
  FROM public.turniq_assignments AS a
  WHERE a.salon_id = p_salon_id AND a.id = v_swap.assignment_id;
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_turniq_assignment_correction_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_assignment_id uuid,
  p_actual_staff_id uuid,
  p_category text,
  p_reason text,
  p_command_id uuid,
  p_device_id uuid,
  p_local_sequence bigint,
  p_actor_user_id uuid,
  p_actor_role text,
  p_request_fingerprint text,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_context jsonb;
  v_replay jsonb;
  v_assignment public.turniq_assignments%ROWTYPE;
  v_previous_shift public.turniq_shift_sessions%ROWTYPE;
  v_actual_shift public.turniq_shift_sessions%ROWTYPE;
  v_receipt public.turniq_fairness_receipts%ROWTYPE;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_actor_staff_id uuid;
  v_sequence integer;
  v_event_version bigint;
  v_turn_delta integer;
  v_credit_delta integer;
  v_correction_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
BEGIN
  IF p_assignment_id IS NULL OR p_actual_staff_id IS NULL OR p_command_id IS NULL
     OR p_device_id IS NULL OR p_local_sequence <= 0
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_category NOT IN (
       'wrong_technician', 'missed_handoff', 'administrative_error', 'other'
     ) OR v_reason IS NULL OR length(v_reason) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ assignment correction';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  v_replay := public.turniq_replay_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
    p_actor_role, 'correction', p_request_fingerprint
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role, p_occurred_at
  );
  v_actor_staff_id := nullif(v_context ->> 'actor_staff_id', '')::uuid;
  IF p_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'completed TurnIQ correction requires Owner/Admin';
  END IF;

  SELECT a.* INTO v_assignment
  FROM public.turniq_assignments AS a
  WHERE a.salon_id = p_salon_id AND a.id = p_assignment_id
  FOR UPDATE;
  SELECT r.* INTO v_receipt
  FROM public.turniq_fairness_receipts AS r
  WHERE r.salon_id = p_salon_id AND r.assignment_id = p_assignment_id;
  IF v_assignment.id IS NULL
     OR v_assignment.policy_version_id IS DISTINCT FROM p_policy_version_id
     OR v_assignment.status <> 'completed'
     OR v_assignment.assigned_staff_id IS NULL
     OR v_assignment.assigned_staff_id = p_actual_staff_id
     OR v_receipt.id IS NULL OR p_occurred_at < v_assignment.completed_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'completed TurnIQ assignment is unavailable for correction';
  END IF;

  SELECT sh.* INTO v_previous_shift
  FROM public.turniq_shift_sessions AS sh
  WHERE sh.salon_id = p_salon_id AND sh.id = v_assignment.shift_session_id;
  SELECT sh.* INTO v_actual_shift
  FROM public.turniq_shift_sessions AS sh
  WHERE sh.salon_id = p_salon_id AND sh.policy_version_id = p_policy_version_id
    AND sh.staff_id = p_actual_staff_id
    AND sh.business_date = v_previous_shift.business_date
    AND sh.checked_in_at <= v_assignment.started_at
    AND (sh.checked_out_at IS NULL OR sh.checked_out_at >= v_assignment.completed_at)
  ORDER BY sh.checked_in_at DESC, sh.id
  LIMIT 1;
  IF v_previous_shift.id IS NULL OR v_actual_shift.id IS NULL
     OR v_previous_shift.id = v_actual_shift.id THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'actual technician has no matching TurnIQ shift';
  END IF;
  PERFORM 1
  FROM public.turniq_shift_sessions AS sh
  WHERE sh.id IN (v_previous_shift.id, v_actual_shift.id)
  ORDER BY sh.id
  FOR UPDATE;
  SELECT sh.* INTO v_previous_shift
  FROM public.turniq_shift_sessions AS sh
  WHERE sh.salon_id = p_salon_id AND sh.id = v_assignment.shift_session_id;
  SELECT sh.* INTO v_actual_shift
  FROM public.turniq_shift_sessions AS sh
  WHERE sh.salon_id = p_salon_id AND sh.id = v_actual_shift.id;
  IF v_previous_shift.id IS NULL OR v_actual_shift.id IS NULL
     OR v_actual_shift.policy_version_id IS DISTINCT FROM p_policy_version_id
     OR v_actual_shift.staff_id IS DISTINCT FROM p_actual_staff_id
     OR v_actual_shift.business_date IS DISTINCT FROM v_previous_shift.business_date
     OR v_actual_shift.checked_in_at > v_assignment.started_at
     OR (v_actual_shift.checked_out_at IS NOT NULL
       AND v_actual_shift.checked_out_at < v_assignment.completed_at) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ correction shift truth changed concurrently';
  END IF;

  v_turn_delta := CASE WHEN v_assignment.turn_consumed THEN 1 ELSE 0 END;
  v_credit_delta := CASE
    WHEN v_assignment.redo_original_assignment_id IS NOT NULL
      AND v_assignment.redo_credits_opportunity = false THEN 0
    ELSE v_assignment.opportunity_credit_cents
  END;
  IF v_previous_shift.turns_consumed < v_turn_delta
     OR v_previous_shift.service_credit_since_checkin_cents < v_credit_delta THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'existing TurnIQ shift totals cannot support correction';
  END IF;

  UPDATE public.turniq_shift_sessions AS sh
  SET turns_consumed = sh.turns_consumed - v_turn_delta,
      service_credit_since_checkin_cents =
        sh.service_credit_since_checkin_cents - v_credit_delta,
      state_version = sh.state_version + 1,
      updated_at = pg_catalog.transaction_timestamp()
  WHERE sh.id = v_previous_shift.id
    AND sh.state_version = v_previous_shift.state_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'previous TurnIQ shift changed concurrently';
  END IF;
  UPDATE public.turniq_shift_sessions AS sh
  SET turns_consumed = sh.turns_consumed + v_turn_delta,
      service_credit_since_checkin_cents =
        sh.service_credit_since_checkin_cents + v_credit_delta,
      state_version = sh.state_version + 1,
      updated_at = pg_catalog.transaction_timestamp()
  WHERE sh.id = v_actual_shift.id
    AND sh.state_version = v_actual_shift.state_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'actual TurnIQ shift changed concurrently';
  END IF;

  UPDATE public.bookings AS b
  SET staff_id = p_actual_staff_id
  WHERE b.salon_id = p_salon_id AND b.id = v_assignment.booking_id
    AND b.status = 'completed'
    AND b.staff_id IS NOT DISTINCT FROM v_assignment.assigned_staff_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'completed booking changed concurrently';
  END IF;
  UPDATE public.turniq_assignments AS a
  SET assigned_staff_id = p_actual_staff_id,
      shift_session_id = v_actual_shift.id,
      state_version = a.state_version + 1,
      updated_at = pg_catalog.transaction_timestamp()
  WHERE a.id = p_assignment_id AND a.state_version = v_assignment.state_version
  RETURNING * INTO v_assignment;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'TurnIQ assignment changed concurrently';
  END IF;

  SELECT coalesce(max(c.correction_sequence), 0) + 1 INTO v_sequence
  FROM public.turniq_assignment_corrections AS c
  WHERE c.salon_id = p_salon_id AND c.assignment_id = p_assignment_id;
  INSERT INTO public.turniq_assignment_corrections (
    id, salon_id, policy_version_id, assignment_id, fairness_receipt_id,
    correction_sequence, category, reason, previous_staff_id, actual_staff_id,
    previous_shift_session_id, actual_shift_session_id, turn_moved,
    opportunity_credit_moved_cents, actor_user_id, corrected_at
  ) VALUES (
    v_correction_id, p_salon_id, p_policy_version_id, p_assignment_id,
    v_receipt.id, v_sequence, p_category, v_reason,
    v_previous_shift.staff_id, p_actual_staff_id,
    v_previous_shift.id, v_actual_shift.id, v_turn_delta = 1,
    v_credit_delta, p_actor_user_id, p_occurred_at
  );

  SELECT coalesce(max(e.aggregate_version), 0) + 1 INTO v_event_version
  FROM public.turniq_events AS e
  WHERE e.salon_id = p_salon_id AND e.aggregate_type = 'assignment'
    AND e.aggregate_id = p_assignment_id;
  v_result := pg_catalog.jsonb_build_object(
    'ok', true, 'command_id', p_command_id, 'replayed', false,
    'correction_id', v_correction_id, 'assignment_id', p_assignment_id,
    'status', v_assignment.status, 'state_version', v_assignment.state_version,
    'previous_staff_id', v_previous_shift.staff_id,
    'actual_staff_id', p_actual_staff_id, 'turn_moved', v_turn_delta = 1,
    'opportunity_credit_moved_cents', v_credit_delta
  );
  PERFORM public.turniq_store_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, 'correction',
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );
  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
    aggregate_id, aggregate_version, event_type, actor_user_id, actor_staff_id,
    actor_role, actor_ref, reason_code, reason_detail, decision_fingerprint,
    request_fingerprint, payload, occurred_at
  ) VALUES (
    p_salon_id, p_policy_version_id, p_assignment_id, p_command_id,
    'assignment', p_assignment_id, v_event_version,
    'assignment_performer_corrected', p_actor_user_id, v_actor_staff_id,
    p_actor_role, 'user:' || p_actor_user_id::text, p_category, v_reason,
    v_assignment.decision_fingerprint, p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'correction_id', v_correction_id,
      'fairness_receipt_id', v_receipt.id,
      'correction_sequence', v_sequence,
      'previous_staff_id', v_previous_shift.staff_id,
      'actual_staff_id', p_actual_staff_id,
      'turn_moved', v_turn_delta = 1,
      'opportunity_credit_moved_cents', v_credit_delta
    ), p_occurred_at
  );
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.apply_turniq_swap_command_v1(
  uuid, uuid, uuid, uuid, text, uuid, text, text, uuid, uuid, bigint, uuid,
  text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_turniq_assignment_correction_v1(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_turniq_swap_command_v1(
  uuid, uuid, uuid, uuid, text, uuid, text, text, uuid, uuid, bigint, uuid,
  text, text, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_turniq_assignment_correction_v1(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) TO service_role;

COMMENT ON TABLE public.turniq_assignment_swaps IS
  'Audited pre-service assignment transfers; both affected technicians consent and a desk actor applies.';
COMMENT ON TABLE public.turniq_swap_consents IS
  'Append-only technician decisions. No actor may consent on behalf of another technician.';
COMMENT ON TABLE public.turniq_assignment_corrections IS
  'Append-only completed-assignment performer corrections. Original Fairness Receipts remain immutable.';

COMMIT;

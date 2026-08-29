-- V1 no-show safety boundary.
--
-- A desk tap first creates a reversible, booking-member-scoped decision. The
-- booking keeps its slot and all downstream effects stay dormant for 60
-- seconds. A service-only finalizer then commits the terminal transition once,
-- records salon-scoped no-show history in the same transaction, and exposes a durable
-- post-commit effects lease. Customer money movement is intentionally absent.

CREATE TABLE IF NOT EXISTS public.booking_no_show_decisions (
  id uuid PRIMARY KEY,
  salon_id uuid NOT NULL REFERENCES public.salons(id),
  booking_id uuid NOT NULL REFERENCES public.bookings(id),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'committed', 'undone', 'invalidated')),
  original_status text NOT NULL
    CHECK (original_status IN ('confirmed', 'in_progress')),
  scope text NOT NULL DEFAULT 'booking_member'
    CHECK (scope = 'booking_member'),
  requested_by_user_id uuid,
  requested_by_role text NOT NULL
    CHECK (requested_by_role IN (
      'owner', 'admin', 'senior', 'receptionist', 'demo_cookie'
    )),
  assist_mode text NOT NULL DEFAULT 'assist'
    CHECK (assist_mode = 'assist'),
  assist_reason_code text NOT NULL
    CHECK (assist_reason_code IN ('scheduler_candidate', 'desk_observation')),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  commit_after timestamptz NOT NULL,
  committed_at timestamptz,
  undone_at timestamptz,
  invalidated_at timestamptz,
  invalidated_reason text,
  effects_state text NOT NULL DEFAULT 'not_ready'
    CHECK (effects_state IN (
      'not_ready', 'pending', 'processing', 'completed', 'failed', 'unknown'
    )),
  waitlist_effect_status text NOT NULL DEFAULT 'not_ready'
    CHECK (waitlist_effect_status IN (
      'not_ready', 'pending', 'completed', 'failed', 'unknown'
    )),
  owner_effect_status text NOT NULL DEFAULT 'not_ready'
    CHECK (owner_effect_status IN (
      'not_ready', 'pending', 'completed', 'failed', 'unknown'
    )),
  customer_effect_status text NOT NULL DEFAULT 'suppressed_v1'
    CHECK (customer_effect_status = 'suppressed_v1'),
  effects_attempt_count integer NOT NULL DEFAULT 0
    CHECK (effects_attempt_count BETWEEN 0 AND 10),
  effects_next_attempt_at timestamptz,
  effects_lease_token uuid,
  effects_lease_expires_at timestamptz,
  effects_completed_at timestamptz,
  last_effect_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT booking_no_show_decisions_commit_window_check
    CHECK (commit_after >= requested_at + interval '60 seconds'),
  CONSTRAINT booking_no_show_decisions_terminal_timestamps_check
    CHECK (
      (state <> 'committed' OR committed_at IS NOT NULL)
      AND (state <> 'undone' OR undone_at IS NOT NULL)
      AND (state <> 'invalidated' OR invalidated_at IS NOT NULL)
    )
);

COMMENT ON TABLE public.booking_no_show_decisions IS
  'Service-only V1 no-show decision receipts. Pending rows retain the booking slot; only committed rows may release availability or trigger downstream effects.';
COMMENT ON COLUMN public.booking_no_show_decisions.scope IS
  'Always booking_member: a group action affects only the selected guest booking.';
COMMENT ON COLUMN public.booking_no_show_decisions.customer_effect_status IS
  'V1 suppresses automatic no-show customer outreach; marketing remains approval-bound.';

CREATE UNIQUE INDEX IF NOT EXISTS booking_no_show_decisions_active_booking_once
  ON public.booking_no_show_decisions (booking_id)
  WHERE state IN ('pending', 'committed');

CREATE INDEX IF NOT EXISTS booking_no_show_decisions_due_idx
  ON public.booking_no_show_decisions (commit_after, id)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS booking_no_show_decisions_effects_due_idx
  ON public.booking_no_show_decisions (effects_next_attempt_at, committed_at, id)
  WHERE state = 'committed'
    AND effects_state IN ('pending', 'failed', 'processing');

CREATE INDEX IF NOT EXISTS booking_no_show_decisions_salon_booking_idx
  ON public.booking_no_show_decisions (salon_id, booking_id, requested_at DESC);

ALTER TABLE public.booking_no_show_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.booking_no_show_decisions
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.begin_booking_no_show_v1(
  p_request_id uuid,
  p_booking_id uuid,
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_actor_role text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_actual_role text;
  v_booking public.bookings%rowtype;
  v_decision public.booking_no_show_decisions%rowtype;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_request_id IS NULL OR p_booking_id IS NULL OR p_salon_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;

  IF p_actor_user_id IS NOT NULL THEN
    SELECT sm.role
      INTO v_actual_role
      FROM public.salon_members sm
     WHERE sm.salon_id = p_salon_id
       AND sm.user_id = p_actor_user_id
       AND sm.role IN ('owner', 'admin', 'senior', 'receptionist')
     LIMIT 1;
    IF v_actual_role IS NULL OR v_actual_role IS DISTINCT FROM p_actor_role THEN
      RETURN jsonb_build_object('success', false, 'code', 'actor_unauthorized');
    END IF;
  ELSIF p_actor_role <> 'demo_cookie' THEN
    RETURN jsonb_build_object('success', false, 'code', 'actor_unauthorized');
  ELSE
    v_actual_role := p_actor_role;
  END IF;

  SELECT d.*
    INTO v_decision
    FROM public.booking_no_show_decisions d
   WHERE d.id = p_request_id;
  IF FOUND THEN
    IF v_decision.salon_id IS DISTINCT FROM p_salon_id
       OR v_decision.booking_id IS DISTINCT FROM p_booking_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'request_conflict');
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'code', 'decision_replay',
      'decision_id', v_decision.id,
      'state', v_decision.state,
      'commit_after', v_decision.commit_after,
      'scope', v_decision.scope,
      'booking_status', v_decision.original_status,
      'assist_mode', v_decision.assist_mode,
      'assist_reason_code', v_decision.assist_reason_code
    );
  END IF;

  SELECT b.*
    INTO v_booking
    FROM public.bookings b
   WHERE b.id = p_booking_id
     AND b.salon_id = p_salon_id
   FOR UPDATE;
  IF NOT FOUND OR v_booking.status NOT IN ('confirmed', 'in_progress') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_state');
  END IF;
  IF v_booking.start_time_utc IS NULL OR v_booking.start_time_utc > v_now THEN
    RETURN jsonb_build_object('success', false, 'code', 'booking_not_due');
  END IF;

  SELECT d.*
    INTO v_decision
    FROM public.booking_no_show_decisions d
   WHERE d.booking_id = p_booking_id
     AND d.state = 'pending'
   ORDER BY d.requested_at DESC, d.id DESC
   LIMIT 1
   FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'pending_replay',
      'decision_id', v_decision.id,
      'state', v_decision.state,
      'commit_after', v_decision.commit_after,
      'scope', v_decision.scope,
      'booking_status', v_decision.original_status,
      'assist_mode', v_decision.assist_mode,
      'assist_reason_code', v_decision.assist_reason_code
    );
  END IF;

  INSERT INTO public.booking_no_show_decisions (
    id,
    salon_id,
    booking_id,
    original_status,
    requested_by_user_id,
    requested_by_role,
    assist_reason_code,
    requested_at,
    commit_after,
    effects_next_attempt_at
  ) VALUES (
    p_request_id,
    p_salon_id,
    p_booking_id,
    v_booking.status,
    p_actor_user_id,
    v_actual_role,
    CASE
      WHEN v_booking.no_show_candidate_at IS NOT NULL
        THEN 'scheduler_candidate'
      ELSE 'desk_observation'
    END,
    v_now,
    v_now + interval '60 seconds',
    v_now + interval '60 seconds'
  )
  RETURNING * INTO v_decision;

  INSERT INTO public.booking_events (
    booking_id, salon_id, actor_user_id, actor_role, event_type, payload
  ) VALUES (
    p_booking_id,
    p_salon_id,
    p_actor_user_id,
    v_actual_role,
    'booking_no_show_pending',
    jsonb_build_object(
      'decision_id', v_decision.id,
      'scope', 'booking_member',
      'commit_after', v_decision.commit_after,
      'booking_status_preserved', v_booking.status,
      'assist_mode', 'assist',
      'assist_reason_code', v_decision.assist_reason_code,
      'money_movement', 'blocked_v1'
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'code', 'decision_started',
    'decision_id', v_decision.id,
    'state', v_decision.state,
    'commit_after', v_decision.commit_after,
    'scope', v_decision.scope,
    'booking_status', v_booking.status,
    'assist_mode', v_decision.assist_mode,
    'assist_reason_code', v_decision.assist_reason_code
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT d.*
      INTO v_decision
      FROM public.booking_no_show_decisions d
     WHERE d.booking_id = p_booking_id
       AND d.state = 'pending'
     ORDER BY d.requested_at DESC, d.id DESC
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'code', 'pending_replay',
        'decision_id', v_decision.id,
        'state', v_decision.state,
        'commit_after', v_decision.commit_after,
        'scope', v_decision.scope,
        'booking_status', v_decision.original_status,
        'assist_mode', v_decision.assist_mode,
        'assist_reason_code', v_decision.assist_reason_code
      );
    END IF;
    RAISE;
END
$function$;

CREATE OR REPLACE FUNCTION public.undo_booking_no_show_v1(
  p_decision_id uuid,
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_actor_role text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_actual_role text;
  v_decision public.booking_no_show_decisions%rowtype;
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_decision_id IS NULL OR p_salon_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;

  IF p_actor_user_id IS NOT NULL THEN
    SELECT sm.role
      INTO v_actual_role
      FROM public.salon_members sm
     WHERE sm.salon_id = p_salon_id
       AND sm.user_id = p_actor_user_id
       AND sm.role IN ('owner', 'admin', 'senior', 'receptionist')
     LIMIT 1;
    IF v_actual_role IS NULL OR v_actual_role IS DISTINCT FROM p_actor_role THEN
      RETURN jsonb_build_object('success', false, 'code', 'actor_unauthorized');
    END IF;
  ELSIF p_actor_role <> 'demo_cookie' THEN
    RETURN jsonb_build_object('success', false, 'code', 'actor_unauthorized');
  ELSE
    v_actual_role := p_actor_role;
  END IF;

  SELECT d.*
    INTO v_decision
    FROM public.booking_no_show_decisions d
   WHERE d.id = p_decision_id
     AND d.salon_id = p_salon_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_decision');
  END IF;
  IF v_decision.state = 'undone' THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'undo_replay',
      'booking_id', v_decision.booking_id,
      'booking_status_preserved', v_decision.original_status
    );
  END IF;
  IF v_decision.state <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'code', 'undo_window_expired');
  END IF;
  IF clock_timestamp() >= v_decision.commit_after THEN
    RETURN jsonb_build_object('success', false, 'code', 'undo_window_expired');
  END IF;

  UPDATE public.booking_no_show_decisions d
     SET state = 'undone',
         undone_at = clock_timestamp(),
         updated_at = clock_timestamp(),
         effects_state = 'not_ready',
         effects_next_attempt_at = NULL
   WHERE d.id = p_decision_id;

  INSERT INTO public.booking_events (
    booking_id, salon_id, actor_user_id, actor_role, event_type, payload
  ) VALUES (
    v_decision.booking_id,
    v_decision.salon_id,
    p_actor_user_id,
    v_actual_role,
    'booking_no_show_undone',
    jsonb_build_object(
      'decision_id', v_decision.id,
      'scope', 'booking_member',
      'booking_status_preserved', v_decision.original_status,
      'side_effects_dispatched', false,
      'money_movement', 'blocked_v1'
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'code', 'decision_undone',
    'booking_id', v_decision.booking_id,
    'booking_status_preserved', v_decision.original_status
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.finalize_due_booking_no_shows_v1(
  p_decision_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 25,
  p_salon_id uuid DEFAULT NULL
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_decision public.booking_no_show_decisions%rowtype;
  v_booking public.bookings%rowtype;
  v_actual_role text;
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN NEXT jsonb_build_object('success', false, 'code', 'unauthorized');
    RETURN;
  END IF;
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RETURN NEXT jsonb_build_object('success', false, 'code', 'invalid_request');
    RETURN;
  END IF;

  IF p_decision_id IS NOT NULL THEN
    SELECT d.*
      INTO v_decision
     FROM public.booking_no_show_decisions d
     WHERE d.id = p_decision_id
       AND (p_salon_id IS NULL OR d.salon_id = p_salon_id);
    IF NOT FOUND THEN
      RETURN NEXT jsonb_build_object('success', false, 'code', 'invalid_decision');
      RETURN;
    END IF;
    IF v_decision.state = 'committed' THEN
      RETURN NEXT jsonb_build_object(
        'success', true,
        'code', 'commit_replay',
        'decision_id', v_decision.id,
        'booking_id', v_decision.booking_id,
        'salon_id', v_decision.salon_id,
        'effects_state', v_decision.effects_state
      );
      RETURN;
    END IF;
    IF v_decision.state <> 'pending' THEN
      RETURN NEXT jsonb_build_object(
        'success', false,
        'code', 'decision_not_pending',
        'decision_id', v_decision.id
      );
      RETURN;
    END IF;
    IF clock_timestamp() < v_decision.commit_after THEN
      RETURN NEXT jsonb_build_object(
        'success', false,
        'code', 'decision_not_due',
        'decision_id', v_decision.id,
        'commit_after', v_decision.commit_after
      );
      RETURN;
    END IF;
  END IF;

  FOR v_decision IN
    SELECT d.*
      FROM public.booking_no_show_decisions d
     WHERE d.state = 'pending'
       AND d.commit_after <= clock_timestamp()
       AND (p_decision_id IS NULL OR d.id = p_decision_id)
       AND (p_salon_id IS NULL OR d.salon_id = p_salon_id)
     ORDER BY d.commit_after, d.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    v_actual_role := NULL;
    IF v_decision.requested_by_user_id IS NOT NULL THEN
      SELECT sm.role
        INTO v_actual_role
        FROM public.salon_members sm
       WHERE sm.salon_id = v_decision.salon_id
         AND sm.user_id = v_decision.requested_by_user_id
         AND sm.role IN ('owner', 'admin', 'senior', 'receptionist')
       LIMIT 1;
    ELSIF v_decision.requested_by_role = 'demo_cookie' THEN
      v_actual_role := 'demo_cookie';
    END IF;

    IF v_actual_role IS NULL
       OR v_actual_role IS DISTINCT FROM v_decision.requested_by_role THEN
      UPDATE public.booking_no_show_decisions d
         SET state = 'invalidated',
             invalidated_at = clock_timestamp(),
             invalidated_reason = 'actor_unauthorized',
             updated_at = clock_timestamp(),
             effects_next_attempt_at = NULL
       WHERE d.id = v_decision.id;
      RETURN NEXT jsonb_build_object(
        'success', false,
        'code', 'actor_unauthorized',
        'decision_id', v_decision.id
      );
      CONTINUE;
    END IF;

    SELECT b.*
      INTO v_booking
      FROM public.bookings b
     WHERE b.id = v_decision.booking_id
       AND b.salon_id = v_decision.salon_id
     FOR UPDATE;
    IF NOT FOUND OR v_booking.status IS DISTINCT FROM v_decision.original_status THEN
      UPDATE public.booking_no_show_decisions d
         SET state = 'invalidated',
             invalidated_at = clock_timestamp(),
             invalidated_reason = 'booking_state_changed',
             updated_at = clock_timestamp(),
             effects_next_attempt_at = NULL
       WHERE d.id = v_decision.id;
      RETURN NEXT jsonb_build_object(
        'success', false,
        'code', 'booking_state_changed',
        'decision_id', v_decision.id
      );
      CONTINUE;
    END IF;

    PERFORM pg_catalog.set_config(
      'nailiq.v1_terminal_actor_user_id',
      coalesce(v_decision.requested_by_user_id::text, ''),
      true
    );
    PERFORM pg_catalog.set_config(
      'nailiq.v1_terminal_actor_role', v_actual_role, true
    );
    PERFORM pg_catalog.set_config(
      'nailiq.v1_terminal_reason', 'desk_no_show', true
    );

    BEGIN
      UPDATE public.bookings b
         SET status = 'no_show',
             no_show_candidate_at = NULL
       WHERE b.id = v_decision.booking_id
         AND b.salon_id = v_decision.salon_id
         AND b.status = v_decision.original_status;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'no-show decision lost its locked booking row'
          USING errcode = 'NI003';
      END IF;

      UPDATE public.booking_no_show_decisions d
         SET state = 'committed',
             committed_at = clock_timestamp(),
             updated_at = clock_timestamp(),
             effects_state = 'pending',
             waitlist_effect_status = 'pending',
             owner_effect_status = 'pending',
             customer_effect_status = 'suppressed_v1',
             effects_next_attempt_at = clock_timestamp()
       WHERE d.id = v_decision.id
         AND d.state = 'pending';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'no-show decision lost its locked receipt row'
          USING errcode = 'NI004';
      END IF;

      INSERT INTO public.booking_events (
        booking_id, salon_id, actor_user_id, actor_role, event_type, payload
      ) VALUES (
        v_decision.booking_id,
        v_decision.salon_id,
        v_decision.requested_by_user_id,
        v_actual_role,
        'booking_no_show_committed',
        jsonb_build_object(
          'decision_id', v_decision.id,
          'scope', 'booking_member',
          'original_status', v_decision.original_status,
          'assist_mode', 'assist',
          'history_recorded', true,
          'history_scope', 'salon_booking',
          'effects_state', 'pending',
          'customer_outreach', 'suppressed_v1',
          'money_movement', 'blocked_v1'
        )
      );
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('nailiq.v1_terminal_actor_user_id', '', true);
      PERFORM pg_catalog.set_config('nailiq.v1_terminal_actor_role', '', true);
      PERFORM pg_catalog.set_config('nailiq.v1_terminal_reason', '', true);
      RAISE;
    END;

    PERFORM pg_catalog.set_config('nailiq.v1_terminal_actor_user_id', '', true);
    PERFORM pg_catalog.set_config('nailiq.v1_terminal_actor_role', '', true);
    PERFORM pg_catalog.set_config('nailiq.v1_terminal_reason', '', true);

    RETURN NEXT jsonb_build_object(
      'success', true,
      'code', 'decision_committed',
      'decision_id', v_decision.id,
      'booking_id', v_decision.booking_id,
      'salon_id', v_decision.salon_id,
      'scope', 'booking_member',
      'effects_state', 'pending'
    );
  END LOOP;
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_booking_no_show_effects_v1(
  p_decision_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 10,
  p_salon_id uuid DEFAULT NULL
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_decision public.booking_no_show_decisions%rowtype;
  v_token uuid;
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN NEXT jsonb_build_object('success', false, 'code', 'unauthorized');
    RETURN;
  END IF;
  IF p_limit NOT BETWEEN 1 AND 25 THEN
    RETURN NEXT jsonb_build_object('success', false, 'code', 'invalid_request');
    RETURN;
  END IF;

  FOR v_decision IN
    SELECT d.*
      FROM public.booking_no_show_decisions d
     WHERE d.state = 'committed'
       AND d.effects_attempt_count < 10
       AND coalesce(d.effects_next_attempt_at, d.committed_at) <= clock_timestamp()
       AND (d.effects_lease_expires_at IS NULL
         OR d.effects_lease_expires_at <= clock_timestamp())
       AND (
         d.waitlist_effect_status IN ('pending', 'failed')
         OR d.owner_effect_status IN ('pending', 'failed')
       )
       AND (p_decision_id IS NULL OR d.id = p_decision_id)
       AND (p_salon_id IS NULL OR d.salon_id = p_salon_id)
     ORDER BY coalesce(d.effects_next_attempt_at, d.committed_at), d.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    v_token := gen_random_uuid();
    UPDATE public.booking_no_show_decisions d
       SET effects_state = 'processing',
           effects_attempt_count = d.effects_attempt_count + 1,
           effects_lease_token = v_token,
           effects_lease_expires_at = clock_timestamp() + interval '2 minutes',
           updated_at = clock_timestamp()
     WHERE d.id = v_decision.id;

    RETURN NEXT jsonb_build_object(
      'success', true,
      'code', 'effects_leased',
      'decision_id', v_decision.id,
      'booking_id', v_decision.booking_id,
      'salon_id', v_decision.salon_id,
      'lease_token', v_token,
      'occurrence_key', v_decision.id::text,
      'needs_waitlist', v_decision.waitlist_effect_status IN ('pending', 'failed'),
      'needs_owner_notification', v_decision.owner_effect_status IN ('pending', 'failed'),
      'customer_notification', 'suppressed_v1'
    );
  END LOOP;
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_booking_no_show_effects_v1(
  p_decision_id uuid,
  p_lease_token uuid,
  p_waitlist_outcome text DEFAULT NULL,
  p_owner_outcome text DEFAULT NULL,
  p_error_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_decision public.booking_no_show_decisions%rowtype;
  v_waitlist text;
  v_owner text;
  v_state text;
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_decision_id IS NULL OR p_lease_token IS NULL
     OR (p_waitlist_outcome IS NOT NULL AND p_waitlist_outcome NOT IN (
       'completed', 'failed', 'unknown'
     ))
     OR (p_owner_outcome IS NOT NULL AND p_owner_outcome NOT IN (
       'completed', 'failed', 'unknown'
     ))
     OR (p_error_code IS NOT NULL AND (
       length(p_error_code) > 120 OR p_error_code !~ '^[a-z0-9_:-]+$'
     )) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;

  SELECT d.*
    INTO v_decision
    FROM public.booking_no_show_decisions d
   WHERE d.id = p_decision_id
   FOR UPDATE;
  IF NOT FOUND OR v_decision.state <> 'committed' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_decision');
  END IF;
  IF v_decision.effects_lease_token IS DISTINCT FROM p_lease_token THEN
    RETURN jsonb_build_object('success', false, 'code', 'lease_lost');
  END IF;

  v_waitlist := coalesce(p_waitlist_outcome, v_decision.waitlist_effect_status);
  v_owner := coalesce(p_owner_outcome, v_decision.owner_effect_status);
  v_state := CASE
    WHEN v_waitlist = 'failed' OR v_owner = 'failed' THEN 'failed'
    WHEN v_waitlist = 'unknown' OR v_owner = 'unknown' THEN 'unknown'
    WHEN v_waitlist = 'completed' AND v_owner = 'completed' THEN 'completed'
    ELSE 'pending'
  END;

  UPDATE public.booking_no_show_decisions d
     SET waitlist_effect_status = v_waitlist,
         owner_effect_status = v_owner,
         effects_state = v_state,
         effects_next_attempt_at = CASE
           WHEN v_state = 'failed' AND d.effects_attempt_count < 10
             THEN clock_timestamp() + interval '5 minutes'
           ELSE NULL
         END,
         effects_lease_token = NULL,
         effects_lease_expires_at = NULL,
         effects_completed_at = CASE
           WHEN v_state IN ('completed', 'unknown') THEN clock_timestamp()
           ELSE d.effects_completed_at
         END,
         last_effect_error_code = CASE
           WHEN v_state IN ('failed', 'unknown') THEN p_error_code
           ELSE NULL
         END,
         updated_at = clock_timestamp()
   WHERE d.id = p_decision_id;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'effects_recorded',
    'decision_id', p_decision_id,
    'effects_state', v_state,
    'waitlist_effect_status', v_waitlist,
    'owner_effect_status', v_owner,
    'customer_effect_status', 'suppressed_v1'
  );
END
$function$;

REVOKE ALL ON FUNCTION public.begin_booking_no_show_v1(
  uuid, uuid, uuid, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_booking_no_show_v1(
  uuid, uuid, uuid, uuid, text
) TO service_role;

REVOKE ALL ON FUNCTION public.undo_booking_no_show_v1(
  uuid, uuid, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.undo_booking_no_show_v1(
  uuid, uuid, uuid, text
) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_due_booking_no_shows_v1(
  uuid, integer, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_due_booking_no_shows_v1(
  uuid, integer, uuid
) TO service_role;

REVOKE ALL ON FUNCTION public.claim_booking_no_show_effects_v1(
  uuid, integer, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_booking_no_show_effects_v1(
  uuid, integer, uuid
) TO service_role;

REVOKE ALL ON FUNCTION public.complete_booking_no_show_effects_v1(
  uuid, uuid, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_booking_no_show_effects_v1(
  uuid, uuid, text, text, text
) TO service_role;

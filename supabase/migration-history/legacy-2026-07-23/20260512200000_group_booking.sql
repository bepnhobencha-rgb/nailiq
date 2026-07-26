-- Group booking (Phase 1) — atomic multi-row insert with shared `group_id`.
--
-- Scope: 2–4 friends/family book together. Each member is a separate
-- `bookings` row (so individual edit / cancel still works), bound by
-- a shared `group_id` UUID. The whole batch is inserted inside a
-- single transaction so a conflict on member N aborts ALL inserts —
-- no fake rollback loops in app code.
--
-- Reuses the existing `bookings_no_overlap` GIST EXCLUDE constraint
-- (migration 20260430230000) — same-staff overlap during the
-- multi-insert raises 23P01 (exclusion_violation), which the RPC
-- translates to a structured `slot_conflict` error code.

-- 1. Columns ---------------------------------------------------------

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS group_id UUID DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS group_size SMALLINT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key UUID DEFAULT NULL;

-- Partial index — group_id is null for the vast majority of rows
-- (individual bookings). Skipping null keeps the index small.
CREATE INDEX IF NOT EXISTS idx_bookings_group_id
  ON public.bookings (group_id)
  WHERE group_id IS NOT NULL;

-- Idempotency guard — re-submitting the same key (double click,
-- network retry, browser refresh) hits a UNIQUE violation and the
-- RPC surfaces `duplicate_submission` so the client can show the
-- original confirmation instead of creating duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_idempotency
  ON public.bookings (salon_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 2. RPC -------------------------------------------------------------

-- `insert_group_bookings(p_bookings JSONB)` — array of booking-row
-- objects. Inserts them all in one transaction; returns
-- `{ success, group_id, booking_ids }` on happy path or
-- `{ success: false, code }` on the two structured failures.
--
-- Column names match the existing `bookings` schema (`start_time_utc`,
-- `end_time_utc`, `client_notes`) — NOT the shorthand from the spec.

CREATE OR REPLACE FUNCTION public.insert_group_bookings(
  p_bookings JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_id UUID := gen_random_uuid();
  v_group_size SMALLINT := jsonb_array_length(p_bookings);
  v_booking JSONB;
  v_inserted UUID[] := ARRAY[]::UUID[];
  v_new_id UUID;
BEGIN
  IF v_group_size IS NULL OR v_group_size < 2 OR v_group_size > 4 THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'invalid_group_size'
    );
  END IF;

  FOR v_booking IN SELECT * FROM jsonb_array_elements(p_bookings)
  LOOP
    INSERT INTO public.bookings (
      salon_id,
      staff_id,
      service_id,
      client_name,
      client_phone,
      client_email,
      client_notes,
      start_time_utc,
      end_time_utc,
      status,
      price_cents,
      staff_requested_by_client,
      group_id,
      group_size,
      idempotency_key
    )
    VALUES (
      (v_booking->>'salon_id')::UUID,
      (v_booking->>'staff_id')::UUID,
      (v_booking->>'service_id')::UUID,
      v_booking->>'client_name',
      v_booking->>'client_phone',
      v_booking->>'client_email',
      v_booking->>'client_notes',
      (v_booking->>'start_time_utc')::TIMESTAMPTZ,
      (v_booking->>'end_time_utc')::TIMESTAMPTZ,
      'confirmed',
      CASE
        WHEN v_booking ? 'price_cents'
          AND v_booking->>'price_cents' IS NOT NULL
        THEN (v_booking->>'price_cents')::INTEGER
        ELSE NULL
      END,
      COALESCE((v_booking->>'staff_requested_by_client')::BOOLEAN, false),
      v_group_id,
      v_group_size,
      (v_booking->>'idempotency_key')::UUID
    )
    RETURNING id INTO v_new_id;
    v_inserted := array_append(v_inserted, v_new_id);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'group_id', v_group_id,
    'booking_ids', to_jsonb(v_inserted)
  );
EXCEPTION
  WHEN exclusion_violation THEN
    -- GiST overlap — at least one member conflicts with an existing
    -- booking or with another member in the same batch.
    RETURN jsonb_build_object(
      'success', false,
      'code', 'slot_conflict'
    );
  WHEN unique_violation THEN
    -- Idempotency UNIQUE hit — duplicate submission.
    RETURN jsonb_build_object(
      'success', false,
      'code', 'duplicate_submission'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.insert_group_bookings(JSONB)
  TO anon, authenticated;

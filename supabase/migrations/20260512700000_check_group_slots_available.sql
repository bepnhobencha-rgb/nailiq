-- `check_group_slots_available(p_slots JSONB)`
--
-- Pre-submit availability check for the group-booking confirm step
-- (Task #04-C FIX 01). The client calls this when the user lands on
-- step 5 — before they tap Confirm — to verify that none of the
-- per-member slots in their chosen arrangement have been raced by
-- another customer during the user's hesitation.
--
-- The existing `insert_group_bookings` RPC + `bookings_no_overlap`
-- GIST EXCLUDE constraint already catch this race at insert time,
-- but the UX is awful — the user clicks Confirm, waits, sees
-- "slot_conflict", and has to re-pick. This RPC lets us pre-detect
-- the race and trigger a silent auto-rescheduler before the user
-- ever clicks.
--
-- Read-only. Cheap: indexed lookup against `bookings(staff_id,
-- start_time_utc, end_time_utc)` filtered by salon + non-cancelled
-- + non-soft-deleted, same predicate the GIST constraint uses.
--
-- Input shape (each element):
--   {
--     "member_index": 0,
--     "salon_id":     "uuid",
--     "staff_id":     "uuid",
--     "start_time_utc": "2026-05-15T14:00:00Z",
--     "end_time_utc":   "2026-05-15T14:55:00Z"
--   }
--
-- Output:
--   {
--     "available": true                             -- all clear
--   }
--   OR
--   {
--     "available": false,
--     "conflicting_members": [0, 2]                 -- 0-indexed
--   }

CREATE OR REPLACE FUNCTION public.check_group_slots_available(
  p_slots JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slot JSONB;
  v_conflicts INT[] := ARRAY[]::INT[];
  v_member_index INT;
  v_salon_id UUID;
  v_staff_id UUID;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_exists BOOLEAN;
BEGIN
  IF p_slots IS NULL OR jsonb_array_length(p_slots) = 0 THEN
    RETURN jsonb_build_object('available', true);
  END IF;

  FOR v_slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    v_member_index := (v_slot->>'member_index')::INT;
    v_salon_id := (v_slot->>'salon_id')::UUID;
    v_staff_id := (v_slot->>'staff_id')::UUID;
    v_start := (v_slot->>'start_time_utc')::TIMESTAMPTZ;
    v_end := (v_slot->>'end_time_utc')::TIMESTAMPTZ;

    -- Half-open overlap: [a, b) overlaps [c, d) iff a < d AND b > c.
    -- Matches the `bookings_no_overlap` GIST `tstzrange(start, end,
    -- '[)')` semantics exactly so the pre-check and the insert-time
    -- check agree on what counts as a collision.
    SELECT EXISTS (
      SELECT 1
      FROM public.bookings b
      WHERE b.salon_id = v_salon_id
        AND b.staff_id = v_staff_id
        AND b.status <> 'cancelled'
        AND b.deleted_at IS NULL
        AND b.start_time_utc < v_end
        AND b.end_time_utc > v_start
    ) INTO v_exists;

    IF v_exists THEN
      v_conflicts := array_append(v_conflicts, v_member_index);
    END IF;
  END LOOP;

  IF array_length(v_conflicts, 1) IS NULL THEN
    RETURN jsonb_build_object('available', true);
  END IF;

  RETURN jsonb_build_object(
    'available', false,
    'conflicting_members', to_jsonb(v_conflicts)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_group_slots_available(JSONB)
  TO authenticated, anon;

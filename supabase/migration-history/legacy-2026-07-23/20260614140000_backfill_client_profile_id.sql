-- Customer Identity Layer — M7 (backfill).
--
-- Populates bookings.client_profile_id on existing rows by matching the already-
-- canonical client_phone to client_profiles.phone. Batched (5k/iteration) so it
-- never holds a long lock on the bookings table. Idempotent — only touches rows
-- where the FK is still NULL, so it's safe to re-run.
--
-- Deliberately does NOT retro-classify old group members as is_party_member:
-- historical group rows all carry the organizer's phone and there's no reliable
-- signal for which row was the organizer, so reclassifying would be guesswork.
-- The forward fix (M3) already stores new groups correctly; old rows simply link
-- to the profile their phone already implies.

DO $$
DECLARE
  v_batch int;
BEGIN
  LOOP
    WITH todo AS (
      SELECT b.id, cp.id AS profile_id
      FROM public.bookings b
      JOIN public.client_profiles cp
        ON cp.phone = b.client_phone
       AND cp.deleted_at IS NULL
      WHERE b.client_profile_id IS NULL
        AND b.client_phone IS NOT NULL
        AND b.is_party_member = false
      LIMIT 5000
    )
    UPDATE public.bookings b
       SET client_profile_id = todo.profile_id
      FROM todo
     WHERE b.id = todo.id;

    GET DIAGNOSTICS v_batch = ROW_COUNT;
    EXIT WHEN v_batch = 0;
    RAISE NOTICE 'backfill client_profile_id: % rows', v_batch;
  END LOOP;
END $$;

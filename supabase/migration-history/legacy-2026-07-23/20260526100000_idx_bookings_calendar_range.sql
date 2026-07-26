-- Index: fast lookup for calendar views (week + month) and day grid
--
-- Before: full table scan on `bookings` filtered by salon_id + start_time_utc range.
-- After:  index range scan on (salon_id, start_time_utc) — O(log n) seek, then
--         sequential read of matching rows (a tiny fraction of the table per salon).
--
-- Partial WHERE clause excludes the two "dead" statuses (cancelled, waiting) that
-- are never shown in calendar views. Postgres can still use this index for queries
-- that don't include the WHERE predicate, but the predicate shrinks the index size
-- by ~30-40% (typical ratio of cancelled bookings) so it fits better in cache.
--
-- Name: idx_bookings_calendar_range (idempotent with IF NOT EXISTS).

CREATE INDEX IF NOT EXISTS idx_bookings_calendar_range
  ON bookings (salon_id, start_time_utc)
  WHERE status NOT IN ('cancelled', 'waiting');

-- Walk-in queue: receptionist loads source='walkin' AND status='waiting' per salon.
-- Without an index this is a full scan; the partial index below turns it into an
-- index seek (tiny result set per salon, very frequent reload on the live desk).

CREATE INDEX IF NOT EXISTS idx_bookings_walkin_queue
  ON bookings (salon_id, joined_queue_at)
  WHERE source = 'walkin' AND status = 'waiting';

-- Last NailIQ-side local edit timestamp, used for Square reschedule conflict
-- resolution (last-writer-wins): if a booking's local edit is newer than the
-- Square booking's updated_at, NailIQ owns the slot (push NailIQ→Square and don't
-- let the forward pull overwrite it); otherwise Square owns it (pull as before).
-- Stamped by NailIQ desk edit/drag (performEditBooking); customer + voice
-- reschedules already stamp `rescheduled_at`, so the effective signal is
-- GREATEST(local_updated_at, rescheduled_at). NOT set by the Square forward sync.
alter table bookings
  add column if not exists local_updated_at timestamptz;

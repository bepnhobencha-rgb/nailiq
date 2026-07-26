-- Rush-hour start/end events describe the whole salon desk and therefore do
-- not belong to one booking. The application already writes these events with
-- booking_id = NULL; keep the foreign key for booking-specific events while
-- allowing the salon-scoped audit records to be persisted.
ALTER TABLE public.booking_events
  ALTER COLUMN booking_id DROP NOT NULL;

COMMENT ON COLUMN public.booking_events.booking_id IS
  'Booking the event pertains to. NULL for salon-scoped events such as rush_hour_started or rush_hour_ended.';

-- Allow voice bookings to be stored in the bookings table.
-- The previous constraint only allowed 'appointment' and 'walkin';
-- the voice AI route sends p_source = 'voice', causing every booking attempt to fail.

ALTER TABLE bookings DROP CONSTRAINT bookings_source_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_source_check
  CHECK (source = ANY (ARRAY['appointment'::text, 'walkin'::text, 'voice'::text]));

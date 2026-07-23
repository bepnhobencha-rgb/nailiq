-- Defense in depth: block angle brackets (script/HTML injection) in guest names at insert/update.
-- NOT VALID skips checking existing rows so legacy polluted data does not block deploy; run
-- VALIDATE CONSTRAINT bookings_client_name_safe ON bookings after cleanup when ready.
ALTER TABLE public.bookings
ADD CONSTRAINT bookings_client_name_safe CHECK (
    length(trim(client_name)) BETWEEN 1 AND 100
    AND client_name !~ '[<>]'
) NOT VALID;

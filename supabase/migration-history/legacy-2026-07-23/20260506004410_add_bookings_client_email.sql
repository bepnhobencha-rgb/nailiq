-- B-10: optional customer email on bookings — for confirmation email + receipts.
-- Empty stays NULL; format check is defense-in-depth alongside the app-level
-- isValidEmailFormat (src/shared/lib/emailFormat.ts).

ALTER TABLE public.bookings
  ADD COLUMN client_email text NULL
    CHECK (
      client_email IS NULL
      OR (
        length(client_email) BETWEEN 3 AND 254
        AND client_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      )
    );

COMMENT ON COLUMN public.bookings.client_email IS
  'Optional customer email for confirmation. NULL when guest skipped. RFC-ish format check at DB level.';

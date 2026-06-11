-- QA BUG-03: express SMS consent (CASL/TCPA). Stamped when the customer ticks
-- the required consent box at booking. NULL on legacy rows (grandfathered).
alter table public.bookings add column if not exists sms_consent_at timestamptz;

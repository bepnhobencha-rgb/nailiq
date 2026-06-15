-- CASL/CAN-SPAM email opt-out suppression list. A customer who clicks the
-- unsubscribe link in any email is recorded here; optional/marketing emails
-- (reminders, win-back, review requests, waitlist) check this and skip. Purely
-- transactional booking confirmations are exempt and still send.
create table if not exists public.client_email_optouts (
  email text primary key,
  opted_out_at timestamptz not null default now()
);

-- Service-role only (no anon/auth access — managed entirely server-side via the
-- HMAC-signed unsubscribe link). RLS on with no policies = deny all but service.
alter table public.client_email_optouts enable row level security;

comment on table public.client_email_optouts is 'CASL email suppression: emails that unsubscribed; optional emails skip these.';

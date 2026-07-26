-- Self-service 14-day trial lifecycle.
-- Existing salons are intentionally left unchanged. New self-service salons
-- receive these values from completeSalonRegistrationAction on the server.

alter table public.salons
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_ends_at timestamptz;

alter table public.salons
  drop constraint if exists salons_trial_window_check;

alter table public.salons
  add constraint salons_trial_window_check
  check (
    (trial_started_at is null and trial_ends_at is null)
    or (
      trial_started_at is not null
      and trial_ends_at is not null
      and trial_ends_at > trial_started_at
    )
  );

create index if not exists salons_trial_ends_at_idx
  on public.salons (trial_ends_at)
  where subscription_status = 'trialing';

comment on column public.salons.trial_started_at is
  'Server-authored start of the self-service trial. Null for legacy/pilot salons.';
comment on column public.salons.trial_ends_at is
  'Server-authored end of the self-service trial. Access checks must use server time.';

-- Twilio delivery analysis already reads this field. Production had code/schema
-- drift, causing the daily learning cron to fail on every salon.
alter table public.booking_notifications
  add column if not exists error_code text;

comment on column public.booking_notifications.error_code is
  'Provider delivery error code (for example a Twilio 30007/30034 code).';

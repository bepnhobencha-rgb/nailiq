-- Audit trail for owner/manager email alerts.
--
-- Until now sendOwnerBookingNotification wrote nothing anywhere: every failure
-- path was a silent `return`, and the send itself was a fire-and-forget promise
-- that Vercel killed when the response flushed. From the outside there was no
-- way to tell "no booking happened" from "the email never left". This table
-- makes every attempt visible, per recipient.

create table if not exists public.owner_notification_log (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons (id) on delete cascade,
  booking_id uuid,
  event text not null,
  recipient text not null default '',
  status text not null,
  resend_id text,
  error text,
  created_at timestamptz not null default now(),
  constraint owner_notification_log_status_check
    check (status in ('sent', 'failed', 'skipped'))
);

create index if not exists owner_notification_log_salon_created_idx
  on public.owner_notification_log (salon_id, created_at desc);

create index if not exists owner_notification_log_booking_idx
  on public.owner_notification_log (booking_id)
  where booking_id is not null;

-- Service-role only: written by the notification sender, read by the dashboard
-- through server code. RLS on with no policy blocks anon/authenticated outright.
alter table public.owner_notification_log enable row level security;

revoke all on public.owner_notification_log from anon, authenticated;

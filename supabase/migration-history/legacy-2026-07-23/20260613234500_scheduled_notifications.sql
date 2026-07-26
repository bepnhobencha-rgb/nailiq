-- Durable queue for staff-action CUSTOMER notifications (create/reschedule/
-- cancel). Replaces the fragile client-side 8s setTimeout: the desk action
-- enqueues a row with a short grace `send_after`; an Undo flips it to
-- 'cancelled'; a 1-minute cron delivers the still-'pending' ones. So the send
-- survives the tab closing/navigating, is idempotent, and is recorded.
create table if not exists public.scheduled_notifications (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  event text not null check (event in ('create', 'reschedule', 'cancel')),
  channels jsonb not null,                       -- {"sms":bool,"email":bool}
  send_after timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'sent', 'cancelled', 'failed')),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

-- Cron picks pending rows whose grace window has elapsed.
create index if not exists scheduled_notifications_due_idx
  on public.scheduled_notifications (send_after)
  where status = 'pending';

-- Undo cancels by booking_id.
create index if not exists scheduled_notifications_booking_idx
  on public.scheduled_notifications (booking_id);

-- Server-only table: no anon/auth access (writes are service-role from desk
-- actions + the cron). Enable RLS with no policies → deny all by default.
alter table public.scheduled_notifications enable row level security;
revoke all on public.scheduled_notifications from anon, authenticated;

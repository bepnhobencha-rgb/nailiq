-- First-visit nurture sequences
-- Tracks new clients through a 3-step re-engagement sequence after their first booking.
-- Agent checks daily: send next step or mark converted/expired.

create table if not exists first_visit_sequences (
  id              uuid primary key default gen_random_uuid(),
  salon_id        uuid not null references salons(id) on delete cascade,
  client_phone    text not null,
  client_name     text not null default '',
  client_email    text,
  first_booking_id uuid references bookings(id) on delete set null,
  first_service   text,                        -- service name for personalisation
  first_visit_date date not null,
  channel         text not null check (channel in ('sms', 'email')),
  status          text not null default 'active' check (status in ('active', 'converted', 'expired')),
  step            int not null default 0,       -- 0=warmth sent, 1=day-7 sent, 2=day-14 sent
  next_action_date date,                        -- null = sequence complete
  converted_booking_id uuid references bookings(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists first_visit_sequences_salon_status
  on first_visit_sequences(salon_id, status, next_action_date);

create unique index if not exists first_visit_sequences_salon_phone
  on first_visit_sequences(salon_id, client_phone);

-- RLS: service role only (agent runs server-side)
alter table first_visit_sequences enable row level security;

create policy "service role full access"
  on first_visit_sequences
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

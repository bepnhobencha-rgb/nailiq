create table if not exists public.payment_disputes (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid references public.salons(id) on delete cascade,
  provider text not null, provider_dispute_id text not null unique,
  payment_ref text, booking_id uuid references public.bookings(id) on delete set null,
  client_phone text, amount_cents integer, currency text, reason text, status text,
  evidence_due_at timestamptz, raw jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists payment_disputes_salon_idx on public.payment_disputes(salon_id);
create index if not exists payment_disputes_status_idx on public.payment_disputes(status);
alter table public.payment_disputes enable row level security;
revoke all on public.payment_disputes from anon, authenticated;

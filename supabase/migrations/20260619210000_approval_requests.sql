create table if not exists public.approval_requests (
  id              uuid primary key default gen_random_uuid(),
  salon_id        uuid not null references public.salons(id) on delete cascade,
  action_type     text not null,  -- e.g. 'send_us_sms', 'charge_noshow', 'bulk_message', 'price_change'
  summary         text not null,  -- 1-2 sentence human description for the email
  payload         jsonb not null default '{}',  -- full action data to execute on approval
  urgency         text not null default 'normal' check (urgency in ('urgent','normal')),
  status          text not null default 'pending' check (status in ('pending','approved','declined','expired')),
  approve_token   text unique not null default encode(gen_random_bytes(32), 'hex'),
  decline_token   text unique not null default encode(gen_random_bytes(32), 'hex'),
  expires_at      timestamptz not null,
  notified_at     timestamptz,       -- when first email was sent
  reminded_at     timestamptz,       -- when reminder was sent (at most once)
  decided_by      uuid references auth.users(id),
  decided_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists approval_requests_salon_status_idx on public.approval_requests (salon_id, status);
create index if not exists approval_requests_approve_token_idx on public.approval_requests (approve_token);
create index if not exists approval_requests_decline_token_idx on public.approval_requests (decline_token);

alter table public.approval_requests enable row level security;

-- Only service role writes; owners/admins read their own salon's
create policy "service-role write" on public.approval_requests
  for all using (auth.role() = 'service_role');

create policy "owners read own" on public.approval_requests
  for select using (
    salon_id in (
      select salon_id from public.salon_members
      where user_id = auth.uid() and role in ('owner','admin')
    )
  );

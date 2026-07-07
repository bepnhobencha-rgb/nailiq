-- Scheduled marketing campaigns: an owner can queue a campaign (e.g. re-opt-in)
-- to send at a chosen salon-local time; a cron fires the due ones. Generic
-- across campaign types so future campaigns reuse the same scheduler.

create table if not exists public.campaign_schedules (
  id            uuid primary key default gen_random_uuid(),
  salon_id      uuid not null references public.salons(id) on delete cascade,
  campaign_type text not null default 'reoptin' check (campaign_type in ('reoptin')),
  send_limit    integer not null default 200 check (send_limit between 1 and 5000),
  scheduled_at  timestamptz not null,          -- UTC instant to fire
  status        text not null default 'pending'
                check (status in ('pending','processing','sent','canceled','failed')),
  created_by    uuid,
  last_summary  jsonb,
  processed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists campaign_schedules_due_idx on public.campaign_schedules (status, scheduled_at);
create index if not exists campaign_schedules_salon_idx on public.campaign_schedules (salon_id);

-- Service-role only (the runner + server actions use the service client).
alter table public.campaign_schedules enable row level security;

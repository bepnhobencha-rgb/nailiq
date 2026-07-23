-- Minh learning loop — lesson store
-- Agents query this before acting to apply learned rules.
-- scope examples: 'channel', 'cost', 'timing', 'segment'
-- condition: jsonb match (e.g. {"country":"US","a2p":false})
-- source: 'incident:<id>', 'agent:<name>', 'admin'
-- confidence: 0..1, default 0.9 (high trust for manually coded rules)

create table if not exists public.minh_lessons (
  id            uuid primary key default gen_random_uuid(),
  salon_id      uuid references public.salons(id) on delete cascade,
  scope         text not null check (scope in ('channel','cost','timing','segment','policy','general')),
  condition     jsonb not null default '{}',
  rule          text not null,
  source        text not null default 'admin',
  confidence    numeric(4,3) not null default 0.900 check (confidence >= 0 and confidence <= 1),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Global lessons: salon_id IS NULL. Per-salon lessons: salon_id = uuid.
create index if not exists minh_lessons_scope_active_idx on public.minh_lessons (scope, active);
create index if not exists minh_lessons_salon_idx on public.minh_lessons (salon_id) where salon_id is not null;

-- RLS: service-role writes; owners/admins read their salon's lessons + global
alter table public.minh_lessons enable row level security;

create policy "service-role only write" on public.minh_lessons
  for all using (auth.role() = 'service_role');

create policy "owners read own salon + global" on public.minh_lessons
  for select using (
    salon_id is null
    or salon_id in (
      select salon_id from public.salon_members
      where user_id = auth.uid() and role in ('owner','admin')
    )
  );

-- Seed: lesson #1 — US + unregistered A2P → prefer email
-- This is the canonical example of "1 incident → 1 durable rule in the lesson store"
insert into public.minh_lessons (scope, condition, rule, source, confidence, active)
values (
  'channel',
  '{"country":"US","a2p_registered":false}',
  'prefer_email: US salons without A2P 10DLC registration must route messages via email, not SMS. SMS would be silently carrier-dropped and still incurs Twilio fees.',
  'incident:2026-06-19-hilite-anaheim-13-sms',
  0.990,
  true
);

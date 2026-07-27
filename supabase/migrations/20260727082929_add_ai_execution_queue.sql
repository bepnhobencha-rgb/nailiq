-- Durable, auditable execution queue for owner-approved AI actions.
-- This is additive only: no existing data is modified.

create table public.ai_execution_jobs (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  approval_request_id uuid not null references public.approval_requests(id) on delete cascade,
  action_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'waiting_input', 'running', 'succeeded', 'failed', 'canceled')),
  idempotency_key text not null,
  attempt_count integer not null default 0
    check (attempt_count between 0 and 5),
  max_attempts integer not null default 3
    check (max_attempts between 1 and 5),
  available_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (approval_request_id),
  unique (salon_id, idempotency_key)
);

create index ai_execution_jobs_ready_idx
  on public.ai_execution_jobs (status, available_at)
  where status in ('queued', 'failed');

create index ai_execution_jobs_salon_created_idx
  on public.ai_execution_jobs (salon_id, created_at desc);

alter table public.ai_execution_jobs enable row level security;

revoke all on table public.ai_execution_jobs from anon, authenticated;
grant select on table public.ai_execution_jobs to authenticated;
grant all on table public.ai_execution_jobs to service_role;

create policy "salon owners read execution jobs"
  on public.ai_execution_jobs
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.salon_members sm
      where sm.salon_id = ai_execution_jobs.salon_id
        and sm.user_id = (select auth.uid())
        and sm.role in ('owner', 'admin')
    )
  );

create policy "service role manages execution jobs"
  on public.ai_execution_jobs
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.ai_execution_jobs is
  'Durable execution state for AI actions approved by salon owners.';
comment on column public.ai_execution_jobs.idempotency_key is
  'Stable caller-provided key that prevents duplicate execution jobs.';
comment on column public.ai_execution_jobs.status is
  'waiting_input means owner approval exists but required safe execution inputs are still missing.';

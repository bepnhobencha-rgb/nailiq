-- Persist the execution scheduler's last known run so the control center can
-- distinguish an idle queue from a worker that silently stopped running.

create table public.ai_execution_worker_state (
  worker_name text primary key,
  run_id uuid,
  status text not null default 'unknown'
    check (status in ('unknown', 'running', 'succeeded', 'failed')),
  started_at timestamptz,
  completed_at timestamptz,
  succeeded_at timestamptz,
  last_error text,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_execution_worker_state_name_check
    check (worker_name = 'ai_execution')
);

alter table public.ai_execution_worker_state enable row level security;

comment on table public.ai_execution_worker_state is
  'Service-role-only heartbeat for the global AI execution scheduler.';
comment on column public.ai_execution_worker_state.run_id is
  'Fences completion so an older overlapping cron run cannot overwrite a newer run.';

insert into public.ai_execution_worker_state (worker_name)
values ('ai_execution');

create or replace function public.record_ai_execution_worker_heartbeat(
  p_run_id uuid,
  p_phase text,
  p_now timestamptz,
  p_summary jsonb default '{}'::jsonb,
  p_error text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_run_id is null then
    raise exception 'run id is required' using errcode = '22023';
  end if;
  if p_phase not in ('started', 'succeeded', 'failed') then
    raise exception 'invalid heartbeat phase: %', p_phase using errcode = '22023';
  end if;

  if p_phase = 'started' then
    insert into public.ai_execution_worker_state (
      worker_name,
      run_id,
      status,
      started_at,
      completed_at,
      last_error,
      summary,
      updated_at
    ) values (
      'ai_execution',
      p_run_id,
      'running',
      p_now,
      null,
      null,
      coalesce(p_summary, '{}'::jsonb),
      p_now
    )
    on conflict (worker_name) do update
      set run_id = excluded.run_id,
          status = excluded.status,
          started_at = excluded.started_at,
          completed_at = null,
          last_error = null,
          summary = excluded.summary,
          updated_at = excluded.updated_at;
    return true;
  end if;

  update public.ai_execution_worker_state
     set status = p_phase,
         completed_at = p_now,
         succeeded_at = case
           when p_phase = 'succeeded' then p_now
           else succeeded_at
         end,
         last_error = case
           when p_phase = 'failed' then left(coalesce(p_error, 'execution_failed'), 1000)
           else null
         end,
         summary = coalesce(p_summary, '{}'::jsonb),
         updated_at = p_now
   where worker_name = 'ai_execution'
     and run_id = p_run_id;

  return found;
end;
$$;

revoke all on table public.ai_execution_worker_state
  from public, anon, authenticated;
grant select, insert, update on table public.ai_execution_worker_state
  to service_role;

revoke all on function public.record_ai_execution_worker_heartbeat(
  uuid, text, timestamptz, jsonb, text
) from public, anon, authenticated;
grant execute on function public.record_ai_execution_worker_heartbeat(
  uuid, text, timestamptz, jsonb, text
) to service_role;

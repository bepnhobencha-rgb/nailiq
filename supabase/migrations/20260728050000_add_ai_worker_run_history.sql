-- Preserve scheduler run history so a later success cannot erase evidence of
-- an earlier failure from the operator's reliability view.

create table public.ai_worker_runs (
  run_id uuid primary key,
  worker_name text not null
    check (worker_name in ('ai_execution', 'ai_manager')),
  status text not null
    check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null,
  completed_at timestamptz,
  error_code text,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_worker_runs_terminal_shape_check check (
    (status = 'running' and completed_at is null)
    or (status in ('succeeded', 'failed') and completed_at is not null)
  )
);

create index ai_worker_runs_worker_started_idx
  on public.ai_worker_runs (worker_name, started_at desc);

alter table public.ai_worker_runs enable row level security;

comment on table public.ai_worker_runs is
  'Append-only identities and terminal outcomes for NailIQ scheduler runs. Service role records runs; owners consume aggregate reliability through the server.';
comment on column public.ai_worker_runs.error_code is
  'Bounded internal error category only; raw provider or customer data must not be stored.';

revoke all on table public.ai_worker_runs
  from public, anon, authenticated;
grant select, insert, update on table public.ai_worker_runs
  to service_role;

create or replace function public.record_ai_worker_heartbeat(
  p_worker_name text,
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
declare
  history_updated boolean;
  current_updated boolean;
begin
  if p_worker_name not in ('ai_execution', 'ai_manager') then
    raise exception 'invalid worker name: %', p_worker_name using errcode = '22023';
  end if;
  if p_run_id is null then
    raise exception 'run id is required' using errcode = '22023';
  end if;
  if p_phase not in ('started', 'succeeded', 'failed') then
    raise exception 'invalid heartbeat phase: %', p_phase using errcode = '22023';
  end if;

  if p_phase = 'started' then
    insert into public.ai_worker_runs (
      run_id,
      worker_name,
      status,
      started_at,
      summary,
      updated_at
    ) values (
      p_run_id,
      p_worker_name,
      'running',
      p_now,
      coalesce(p_summary, '{}'::jsonb),
      p_now
    )
    on conflict (run_id) do nothing;

    if not found then
      return false;
    end if;

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
      p_worker_name,
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

  update public.ai_worker_runs
     set status = p_phase,
         completed_at = p_now,
         error_code = case
           when p_phase = 'failed' and p_error ~ '^[a-z0-9_:-]{1,120}$'
             then p_error
           when p_phase = 'failed' then 'worker_failed'
           else null
         end,
         summary = coalesce(p_summary, '{}'::jsonb),
         updated_at = p_now
   where run_id = p_run_id
     and worker_name = p_worker_name
     and status in ('running', p_phase);
  history_updated := found;

  update public.ai_execution_worker_state
     set status = p_phase,
         completed_at = p_now,
         succeeded_at = case
           when p_phase = 'succeeded' then p_now
           else succeeded_at
         end,
         last_error = case
           when p_phase = 'failed' then left(coalesce(p_error, 'worker_failed'), 1000)
           else null
         end,
         summary = coalesce(p_summary, '{}'::jsonb),
         updated_at = p_now
   where worker_name = p_worker_name
     and run_id = p_run_id;
  current_updated := found;

  return history_updated and current_updated;
end;
$$;

revoke all on function public.record_ai_worker_heartbeat(
  text, uuid, text, timestamptz, jsonb, text
) from public, anon, authenticated;
grant execute on function public.record_ai_worker_heartbeat(
  text, uuid, text, timestamptz, jsonb, text
) to service_role;

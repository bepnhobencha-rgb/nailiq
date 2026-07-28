-- Extend the fail-honest scheduler heartbeat to the hourly AI Manager
-- orchestrator without changing the existing execution-worker contract.

alter table public.ai_execution_worker_state
  drop constraint ai_execution_worker_state_name_check;

alter table public.ai_execution_worker_state
  add constraint ai_execution_worker_state_name_check
  check (worker_name in ('ai_execution', 'ai_manager'));

comment on table public.ai_execution_worker_state is
  'Service-role-only heartbeat state for NailIQ AI schedulers. The historical table name is retained for a non-destructive migration.';

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

  return found;
end;
$$;

create or replace function public.record_ai_execution_worker_heartbeat(
  p_run_id uuid,
  p_phase text,
  p_now timestamptz,
  p_summary jsonb default '{}'::jsonb,
  p_error text default null
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select public.record_ai_worker_heartbeat(
    'ai_execution',
    p_run_id,
    p_phase,
    p_now,
    p_summary,
    p_error
  );
$$;

insert into public.ai_execution_worker_state (worker_name)
values ('ai_manager')
on conflict (worker_name) do nothing;

revoke all on function public.record_ai_worker_heartbeat(
  text, uuid, text, timestamptz, jsonb, text
) from public, anon, authenticated;
grant execute on function public.record_ai_worker_heartbeat(
  text, uuid, text, timestamptz, jsonb, text
) to service_role;

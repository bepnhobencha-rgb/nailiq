-- Preserve the exact, consent-aware recipient/channel decisions behind each
-- preflight, then allow a fresh ready preflight to be sealed into an immutable
-- no-send dispatch plan. A plan is execution evidence, never send permission.

create table public.ai_campaign_dispatch_preflight_decisions (
  preflight_id uuid not null
    references public.ai_campaign_dispatch_preflights(id) on delete cascade,
  salon_id uuid not null references public.salons(id) on delete cascade,
  client_profile_id uuid not null
    references public.client_profiles(id) on delete cascade,
  sms boolean not null,
  email boolean not null,
  exclusion text,
  created_at timestamptz not null default now(),
  primary key (preflight_id, client_profile_id),
  check (
    (exclusion is null and (sms or email))
    or
    (exclusion is not null and not sms and not email)
  )
);

create index ai_campaign_preflight_decisions_salon_idx
  on public.ai_campaign_dispatch_preflight_decisions (salon_id, created_at desc);

alter table public.ai_campaign_dispatch_preflight_decisions
  enable row level security;
revoke all on table public.ai_campaign_dispatch_preflight_decisions
  from public, anon, authenticated;
grant all on table public.ai_campaign_dispatch_preflight_decisions
  to service_role;

create policy "service role manages campaign preflight decisions"
  on public.ai_campaign_dispatch_preflight_decisions
  for all to service_role
  using (true)
  with check (true);

create trigger ai_campaign_dispatch_preflight_decisions_immutable
  before update or delete
  on public.ai_campaign_dispatch_preflight_decisions
  for each row execute function public.reject_ai_campaign_manifest_mutation();

create table public.ai_campaign_dispatch_plans (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  manifest_id uuid not null
    references public.ai_campaign_manifests(id) on delete cascade,
  preflight_id uuid not null unique
    references public.ai_campaign_dispatch_preflights(id) on delete cascade,
  release_execution_job_id uuid not null
    references public.ai_execution_jobs(id) on delete cascade,
  plan_fingerprint text not null
    check (plan_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null check (status = 'sealed'),
  recipient_count integer not null check (recipient_count > 0),
  sms_recipient_count integer not null
    check (sms_recipient_count >= 0),
  email_recipient_count integer not null
    check (email_recipient_count >= 0),
  estimated_cost_usd_cents numeric(12, 4) not null
    check (estimated_cost_usd_cents >= 0),
  expires_at timestamptz not null,
  dispatch_enabled boolean not null default false
    check (dispatch_enabled = false),
  no_messages_sent boolean not null default true
    check (no_messages_sent = true),
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index ai_campaign_dispatch_plans_salon_created_idx
  on public.ai_campaign_dispatch_plans (salon_id, created_at desc);

alter table public.ai_campaign_dispatch_plans enable row level security;
revoke all on table public.ai_campaign_dispatch_plans
  from public, anon, authenticated;
grant all on table public.ai_campaign_dispatch_plans to service_role;

create policy "service role manages campaign dispatch plans"
  on public.ai_campaign_dispatch_plans
  for all to service_role
  using (true)
  with check (true);

create trigger ai_campaign_dispatch_plans_immutable
  before update or delete on public.ai_campaign_dispatch_plans
  for each row execute function public.reject_ai_campaign_manifest_mutation();

create or replace function public.record_ai_campaign_preflight_evidence(
  p_job_id uuid,
  p_salon_id uuid,
  p_summary jsonb,
  p_decisions jsonb
)
returns table (
  outcome text,
  preflight_id uuid,
  preflight_status text,
  preflight_fingerprint text,
  valid_until timestamptz,
  decision_count integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_result record;
  v_inserted_count integer;
  v_stored_count integer;
begin
  select *
    into v_result
    from public.record_ai_campaign_dispatch_preflight_fresh(
      p_job_id,
      p_salon_id,
      p_summary,
      p_decisions
    );

  if v_result.outcome not in ('created', 'unchanged', 'refreshed')
     or v_result.preflight_id is null then
    return query
      select
        v_result.outcome,
        v_result.preflight_id,
        v_result.preflight_status,
        v_result.preflight_fingerprint,
        v_result.valid_until,
        null::integer;
    return;
  end if;

  insert into public.ai_campaign_dispatch_preflight_decisions (
    preflight_id,
    salon_id,
    client_profile_id,
    sms,
    email,
    exclusion,
    created_at
  )
  select
    v_result.preflight_id,
    p_salon_id,
    (item ->> 'client_profile_id')::uuid,
    (item ->> 'sms')::boolean,
    (item ->> 'email')::boolean,
    item ->> 'exclusion',
    statement_timestamp()
  from jsonb_array_elements(p_decisions) item
  on conflict (preflight_id, client_profile_id) do nothing;

  get diagnostics v_inserted_count = row_count;

  select count(*)
    into v_stored_count
    from public.ai_campaign_dispatch_preflight_decisions decision_row
   where decision_row.preflight_id = v_result.preflight_id
     and decision_row.salon_id = p_salon_id;

  if v_stored_count <> jsonb_array_length(p_decisions)
     or exists (
       (
         select
           decision_row.client_profile_id::text,
           decision_row.sms,
           decision_row.email,
           decision_row.exclusion
         from public.ai_campaign_dispatch_preflight_decisions decision_row
         where decision_row.preflight_id = v_result.preflight_id
       )
       except
       (
         select
           item ->> 'client_profile_id',
           (item ->> 'sms')::boolean,
           (item ->> 'email')::boolean,
           item ->> 'exclusion'
         from jsonb_array_elements(p_decisions) item
       )
     )
     or exists (
       (
         select
           item ->> 'client_profile_id',
           (item ->> 'sms')::boolean,
           (item ->> 'email')::boolean,
           item ->> 'exclusion'
         from jsonb_array_elements(p_decisions) item
       )
       except
       (
         select
           decision_row.client_profile_id::text,
           decision_row.sms,
           decision_row.email,
           decision_row.exclusion
         from public.ai_campaign_dispatch_preflight_decisions decision_row
         where decision_row.preflight_id = v_result.preflight_id
       )
     ) then
    raise exception 'campaign_preflight_decisions_mismatch'
      using errcode = '40001';
  end if;

  if v_inserted_count > 0 then
    insert into public.ai_actions_log (
      salon_id,
      agent,
      action_type,
      target_id,
      payload,
      created_at
    ) values (
      p_salon_id,
      'execution_worker',
      'campaign_dispatch_preflight_decisions_recorded',
      p_job_id,
      jsonb_build_object(
        'preflight_id', v_result.preflight_id,
        'decision_count', v_stored_count,
        'dispatch_enabled', false,
        'no_messages_sent', true
      ),
      statement_timestamp()
    );
  end if;

  return query
    select
      v_result.outcome,
      v_result.preflight_id,
      v_result.preflight_status,
      v_result.preflight_fingerprint,
      v_result.valid_until,
      v_stored_count;
end;
$$;

create or replace function public.seal_ai_campaign_dispatch_plan(
  p_job_id uuid,
  p_salon_id uuid
)
returns table (
  outcome text,
  plan_id uuid,
  plan_status text,
  plan_fingerprint text,
  expires_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_job public.ai_execution_jobs%rowtype;
  v_preflight public.ai_campaign_dispatch_preflights%rowtype;
  v_plan public.ai_campaign_dispatch_plans%rowtype;
  v_preflight_id uuid;
  v_recipient_count integer;
  v_sms_count integer;
  v_email_count integer;
  v_estimated_cost numeric;
  v_plan_fingerprint text;
begin
  select *
    into v_job
    from public.ai_execution_jobs job_row
   where job_row.id = p_job_id
     and job_row.salon_id = p_salon_id
   for update;

  if not found
     or v_job.action_type <> 'bulk_message'
     or v_job.status <> 'waiting_input'
     or coalesce(v_job.result ->> 'blocker', '') <> 'dispatch_not_enabled'
     or coalesce(v_job.payload ->> 'dispatch_enabled', '') <> 'false' then
    return query
      select 'job_not_plannable'::text, null::uuid, null::text,
             null::text, null::timestamptz;
    return;
  end if;

  begin
    v_preflight_id := (v_job.result ->> 'dispatch_preflight_id')::uuid;
  exception when others then
    return query
      select 'fresh_preflight_required'::text, null::uuid, null::text,
             null::text, null::timestamptz;
    return;
  end;

  select *
    into v_preflight
    from public.ai_campaign_dispatch_preflights preflight_row
   where preflight_row.id = v_preflight_id
     and preflight_row.salon_id = p_salon_id
     and preflight_row.release_execution_job_id = p_job_id
     and preflight_row.status = 'ready'
     and preflight_row.valid_until > v_now;

  if not found
     or coalesce(v_preflight.summary ->> 'dispatch_enabled', '') <> 'false'
     or coalesce(v_preflight.summary ->> 'no_messages_sent', '') <> 'true'
     or coalesce(v_preflight.summary ->> 'within_recipient_cap', '') <> 'true'
     or coalesce(v_preflight.summary ->> 'within_cost_cap', '') <> 'true' then
    return query
      select 'fresh_preflight_required'::text, null::uuid, null::text,
             null::text, null::timestamptz;
    return;
  end if;

  select *
    into v_plan
    from public.ai_campaign_dispatch_plans plan_row
   where plan_row.preflight_id = v_preflight.id;

  if found then
    return query
      select 'unchanged'::text, v_plan.id, v_plan.status,
             v_plan.plan_fingerprint, v_plan.expires_at;
    return;
  end if;

  select
    count(*) filter (
      where decision_row.exclusion is null
        and (decision_row.sms or decision_row.email)
    ),
    count(*) filter (
      where decision_row.exclusion is null and decision_row.sms
    ),
    count(*) filter (
      where decision_row.exclusion is null and decision_row.email
    )
    into v_recipient_count, v_sms_count, v_email_count
    from public.ai_campaign_dispatch_preflight_decisions decision_row
   where decision_row.preflight_id = v_preflight.id
     and decision_row.salon_id = p_salon_id;

  v_estimated_cost :=
    (v_preflight.summary ->> 'estimated_cost_usd_cents')::numeric;

  if v_recipient_count <= 0
     or v_recipient_count <>
        (v_preflight.summary ->> 'eligible_count')::integer
     or v_sms_count <>
        (v_preflight.summary ->> 'sms_recipient_count')::integer
     or v_email_count <>
        (v_preflight.summary ->> 'email_recipient_count')::integer
     or v_recipient_count > 500
     or v_estimated_cost > 500 then
    return query
      select 'decision_evidence_mismatch'::text, null::uuid, null::text,
             null::text, null::timestamptz;
    return;
  end if;

  v_plan_fingerprint := encode(
    extensions.digest(
      convert_to(
        concat_ws(
          '|',
          v_preflight.id::text,
          v_preflight.preflight_fingerprint,
          v_preflight.valid_until::text,
          v_recipient_count::text,
          v_sms_count::text,
          v_email_count::text,
          v_estimated_cost::text
        ),
        'utf8'
      ),
      'sha256'
    ),
    'hex'
  );

  insert into public.ai_campaign_dispatch_plans (
    salon_id,
    manifest_id,
    preflight_id,
    release_execution_job_id,
    plan_fingerprint,
    status,
    recipient_count,
    sms_recipient_count,
    email_recipient_count,
    estimated_cost_usd_cents,
    expires_at,
    dispatch_enabled,
    no_messages_sent,
    created_at
  ) values (
    p_salon_id,
    v_preflight.manifest_id,
    v_preflight.id,
    p_job_id,
    v_plan_fingerprint,
    'sealed',
    v_recipient_count,
    v_sms_count,
    v_email_count,
    v_estimated_cost,
    v_preflight.valid_until,
    false,
    true,
    v_now
  )
  returning * into v_plan;

  update public.ai_execution_jobs
     set result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'blocker', 'dispatch_not_enabled',
           'dispatch_plan', jsonb_build_object(
             'plan_id', v_plan.id,
             'plan_status', v_plan.status,
             'plan_fingerprint', v_plan.plan_fingerprint,
             'recipient_count', v_plan.recipient_count,
             'sms_recipient_count', v_plan.sms_recipient_count,
             'email_recipient_count', v_plan.email_recipient_count,
             'estimated_cost_usd_cents',
               v_plan.estimated_cost_usd_cents,
             'expires_at', v_plan.expires_at,
             'dispatch_enabled', false,
             'no_messages_sent', true
           ),
           'dispatch_plan_id', v_plan.id,
           'dispatch_enabled', false,
           'no_messages_sent', true
         ),
         updated_at = v_now
   where id = p_job_id
     and salon_id = p_salon_id
     and status = 'waiting_input'
     and coalesce(result ->> 'blocker', '') = 'dispatch_not_enabled';

  if not found then
    raise exception 'campaign_dispatch_plan_state_changed'
      using errcode = '40001';
  end if;

  insert into public.ai_actions_log (
    salon_id,
    agent,
    action_type,
    target_id,
    payload,
    created_at
  ) values (
    p_salon_id,
    'execution_worker',
    'campaign_dispatch_plan_sealed',
    p_job_id,
    jsonb_build_object(
      'plan_id', v_plan.id,
      'preflight_id', v_preflight.id,
      'manifest_id', v_preflight.manifest_id,
      'plan_fingerprint', v_plan.plan_fingerprint,
      'recipient_count', v_plan.recipient_count,
      'sms_recipient_count', v_plan.sms_recipient_count,
      'email_recipient_count', v_plan.email_recipient_count,
      'estimated_cost_usd_cents', v_plan.estimated_cost_usd_cents,
      'expires_at', v_plan.expires_at,
      'dispatch_enabled', false,
      'no_messages_sent', true
    ),
    v_now
  );

  return query
    select 'created'::text, v_plan.id, v_plan.status,
           v_plan.plan_fingerprint, v_plan.expires_at;
end;
$$;

revoke all on function public.record_ai_campaign_preflight_evidence(
  uuid, uuid, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.record_ai_campaign_preflight_evidence(
  uuid, uuid, jsonb, jsonb
) to service_role;

revoke all on function public.seal_ai_campaign_dispatch_plan(
  uuid, uuid
) from public, anon, authenticated;
grant execute on function public.seal_ai_campaign_dispatch_plan(
  uuid, uuid
) to service_role;

comment on table public.ai_campaign_dispatch_preflight_decisions is
  'Immutable, PII-free recipient/channel evidence for one point-in-time campaign safety check.';
comment on table public.ai_campaign_dispatch_plans is
  'Immutable no-send plan sealed from a fresh ready preflight; never grants dispatch permission.';
comment on function public.record_ai_campaign_preflight_evidence(
  uuid, uuid, jsonb, jsonb
) is
  'Records fresh campaign preflight evidence plus exact PII-free recipient/channel decisions.';
comment on function public.seal_ai_campaign_dispatch_plan(uuid, uuid) is
  'Idempotently seals a fresh ready preflight into an immutable plan while live dispatch remains disabled.';

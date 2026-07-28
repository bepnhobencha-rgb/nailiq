-- Record a fresh, consent-aware dispatch preflight for an approved immutable
-- manifest. This adds no sender and never changes dispatch_enabled.

create table public.ai_campaign_dispatch_preflights (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  manifest_id uuid not null
    references public.ai_campaign_manifests(id) on delete cascade,
  release_execution_job_id uuid not null
    references public.ai_execution_jobs(id) on delete cascade,
  preflight_fingerprint text not null
    check (preflight_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('ready', 'blocked')),
  summary jsonb not null,
  created_at timestamptz not null default now(),
  unique (manifest_id, preflight_fingerprint)
);

create index ai_campaign_dispatch_preflights_salon_created_idx
  on public.ai_campaign_dispatch_preflights (salon_id, created_at desc);

alter table public.ai_campaign_dispatch_preflights enable row level security;
revoke all on table public.ai_campaign_dispatch_preflights
  from public, anon, authenticated;
grant all on table public.ai_campaign_dispatch_preflights to service_role;

create policy "service role manages campaign dispatch preflights"
  on public.ai_campaign_dispatch_preflights
  for all to service_role
  using (true)
  with check (true);

create trigger ai_campaign_dispatch_preflights_immutable
  before update or delete on public.ai_campaign_dispatch_preflights
  for each row execute function public.reject_ai_campaign_manifest_mutation();

create or replace function public.record_ai_campaign_dispatch_preflight(
  p_job_id uuid,
  p_salon_id uuid,
  p_summary jsonb,
  p_decisions jsonb,
  p_now timestamptz
)
returns table (
  outcome text,
  preflight_id uuid,
  preflight_status text,
  preflight_fingerprint text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.ai_execution_jobs%rowtype;
  v_manifest public.ai_campaign_manifests%rowtype;
  v_manifest_id uuid;
  v_preflight public.ai_campaign_dispatch_preflights%rowtype;
  v_decision_count integer;
  v_unique_count integer;
  v_eligible_count integer;
  v_sms_count integer;
  v_email_count integer;
  v_dual_count integer;
  v_recent_count integer;
  v_no_consent_count integer;
  v_no_channel_count integer;
  v_missing_profile_count integer;
  v_manifest_channel_count integer;
  v_estimated_cost numeric;
  v_fingerprint text;
  v_status text;
  v_normalized_summary jsonb;
begin
  if jsonb_typeof(p_summary) <> 'object'
     or jsonb_typeof(p_decisions) <> 'array'
     or coalesce(p_summary ->> 'no_messages_sent', '') <> 'true'
     or coalesce(p_summary ->> 'dispatch_enabled', '') <> 'false'
     or coalesce(p_summary ->> 'preflight_fingerprint', '') !~
        '^[0-9a-f]{64}$'
     or coalesce(p_summary ->> 'manifest_recipient_count', '') !~ '^[0-9]+$'
     or coalesce(p_summary ->> 'eligible_count', '') !~ '^[0-9]+$'
     or coalesce(p_summary ->> 'sms_recipient_count', '') !~ '^[0-9]+$'
     or coalesce(p_summary ->> 'email_recipient_count', '') !~ '^[0-9]+$'
     or coalesce(p_summary ->> 'dual_channel_count', '') !~ '^[0-9]+$'
     or coalesce(p_summary ->> 'excluded_recent_contact', '') !~ '^[0-9]+$'
     or coalesce(p_summary ->> 'excluded_no_consent', '') !~ '^[0-9]+$'
     or coalesce(p_summary ->> 'excluded_no_channel', '') !~ '^[0-9]+$'
     or coalesce(p_summary ->> 'excluded_missing_profile', '') !~ '^[0-9]+$'
     or coalesce(
       p_summary ->> 'excluded_manifest_channel_unavailable',
       ''
     ) !~ '^[0-9]+$'
     or coalesce(p_summary ->> 'estimated_cost_usd_cents', '') !~
        '^[0-9]+([.][0-9]+)?$'
     or coalesce(p_summary ->> 'recipient_cap', '') <> '500'
     or coalesce(p_summary ->> 'cost_cap_usd_cents', '') <> '500'
     or p_now is null
     or jsonb_array_length(p_decisions) > 500 then
    return query
      select 'invalid_preflight'::text, null::uuid, null::text, null::text;
    return;
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_decisions) item
     where jsonb_typeof(item) <> 'object'
        or coalesce(item ->> 'client_profile_id', '') !~
           '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        or jsonb_typeof(item -> 'sms') <> 'boolean'
        or jsonb_typeof(item -> 'email') <> 'boolean'
        or (
          (item ->> 'exclusion') is null
          and not (
            (item ->> 'sms')::boolean or (item ->> 'email')::boolean
          )
        )
        or (
          (item ->> 'exclusion') is not null
          and (
            item ->> 'exclusion' not in (
              'recent_contact',
              'no_consent',
              'no_channel',
              'missing_profile',
              'manifest_channel_unavailable'
            )
            or (item ->> 'sms')::boolean
            or (item ->> 'email')::boolean
          )
        )
  ) then
    return query
      select 'invalid_decisions'::text, null::uuid, null::text, null::text;
    return;
  end if;

  select
    count(*)::integer,
    count(distinct lower(item ->> 'client_profile_id'))::integer,
    count(*) filter (where (item ->> 'exclusion') is null)::integer,
    count(*) filter (where (item ->> 'sms')::boolean)::integer,
    count(*) filter (where (item ->> 'email')::boolean)::integer,
    count(*) filter (
      where (item ->> 'sms')::boolean and (item ->> 'email')::boolean
    )::integer,
    count(*) filter (
      where item ->> 'exclusion' = 'recent_contact'
    )::integer,
    count(*) filter (
      where item ->> 'exclusion' = 'no_consent'
    )::integer,
    count(*) filter (
      where item ->> 'exclusion' = 'no_channel'
    )::integer,
    count(*) filter (
      where item ->> 'exclusion' = 'missing_profile'
    )::integer,
    count(*) filter (
      where item ->> 'exclusion' = 'manifest_channel_unavailable'
    )::integer,
    encode(
      extensions.digest(
        convert_to(
          coalesce(
            string_agg(
              lower(item ->> 'client_profile_id') || ':' ||
              case when (item ->> 'sms')::boolean then 's' else '' end ||
              case when (item ->> 'email')::boolean then 'e' else '' end ||
              ':' || coalesce(item ->> 'exclusion', 'eligible'),
              '|' order by lower(item ->> 'client_profile_id')
            ),
            ''
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    into v_decision_count, v_unique_count, v_eligible_count, v_sms_count,
         v_email_count, v_dual_count, v_recent_count, v_no_consent_count,
         v_no_channel_count, v_missing_profile_count,
         v_manifest_channel_count, v_fingerprint
    from jsonb_array_elements(p_decisions) item;

  v_estimated_cost :=
    round((v_sms_count * 0.79 + v_email_count * 0.10)::numeric, 1);

  if v_decision_count <> v_unique_count
     or v_decision_count <>
        (p_summary ->> 'manifest_recipient_count')::integer
     or v_eligible_count <> (p_summary ->> 'eligible_count')::integer
     or v_sms_count <> (p_summary ->> 'sms_recipient_count')::integer
     or v_email_count <> (p_summary ->> 'email_recipient_count')::integer
     or v_dual_count <> (p_summary ->> 'dual_channel_count')::integer
     or v_recent_count <> (p_summary ->> 'excluded_recent_contact')::integer
     or v_no_consent_count <> (p_summary ->> 'excluded_no_consent')::integer
     or v_no_channel_count <> (p_summary ->> 'excluded_no_channel')::integer
     or v_missing_profile_count <>
        (p_summary ->> 'excluded_missing_profile')::integer
     or v_manifest_channel_count <>
        (p_summary ->> 'excluded_manifest_channel_unavailable')::integer
     or v_estimated_cost <>
        (p_summary ->> 'estimated_cost_usd_cents')::numeric
     or v_fingerprint <> p_summary ->> 'preflight_fingerprint' then
    return query
      select 'preflight_mismatch'::text, null::uuid, null::text, v_fingerprint;
    return;
  end if;

  select *
    into v_job
    from public.ai_execution_jobs j
   where j.id = p_job_id
     and j.salon_id = p_salon_id
     and j.action_type = 'bulk_message'
   for update;

  if not found
     or v_job.status <> 'waiting_input'
     or coalesce(v_job.result ->> 'blocker', '') <> 'dispatch_not_enabled'
     or coalesce(v_job.payload ->> 'dispatch_enabled', '') <> 'false' then
    return query
      select 'job_not_preflightable'::text, null::uuid, null::text, null::text;
    return;
  end if;

  select ar.release_manifest_id
    into v_manifest_id
    from public.approval_requests ar
   where ar.id = v_job.approval_request_id
     and ar.salon_id = v_job.salon_id
     and ar.status = 'approved';

  if v_manifest_id is null then
    return query
      select 'manifest_not_found'::text, null::uuid, null::text, null::text;
    return;
  end if;

  select *
    into v_manifest
    from public.ai_campaign_manifests m
   where m.id = v_manifest_id
     and m.salon_id = v_job.salon_id;

  if not found
     or p_summary ->> 'manifest_id' <> v_manifest.id::text
     or v_manifest.audience_fingerprint <>
        coalesce(v_job.payload ->> 'audience_fingerprint', '') then
    return query
      select 'manifest_mismatch'::text, null::uuid, null::text, null::text;
    return;
  end if;

  if v_decision_count <> (
       select count(*)::integer
         from public.ai_campaign_manifest_recipients mr
        where mr.manifest_id = v_manifest.id
     )
     or exists (
       select 1
         from jsonb_array_elements(p_decisions) item
         left join public.ai_campaign_manifest_recipients mr
           on mr.manifest_id = v_manifest.id
          and mr.client_profile_id =
              (item ->> 'client_profile_id')::uuid
        where mr.client_profile_id is null
           or (
             (item ->> 'sms')::boolean and not mr.sms
           )
           or (
             (item ->> 'email')::boolean and not mr.email
           )
     ) then
    return query
      select 'decision_scope_mismatch'::text, null::uuid, null::text,
             null::text;
    return;
  end if;

  select *
    into v_preflight
    from public.ai_campaign_dispatch_preflights p
   where p.manifest_id = v_manifest.id
     and p.preflight_fingerprint = v_fingerprint;

  if found then
    return query
      select 'unchanged'::text, v_preflight.id, v_preflight.status,
             v_preflight.preflight_fingerprint;
    return;
  end if;

  v_status := case
    when v_eligible_count > 0
     and v_decision_count <= 500
     and v_estimated_cost <= 500
      then 'ready'
    else 'blocked'
  end;

  v_normalized_summary := p_summary || jsonb_build_object(
    'preflight_at', p_now,
    'preflight_status', v_status,
    'within_recipient_cap', v_decision_count <= 500,
    'within_cost_cap', v_estimated_cost <= 500,
    'dispatch_enabled', false,
    'no_messages_sent', true
  );

  insert into public.ai_campaign_dispatch_preflights (
    salon_id,
    manifest_id,
    release_execution_job_id,
    preflight_fingerprint,
    status,
    summary,
    created_at
  ) values (
    v_job.salon_id,
    v_manifest.id,
    v_job.id,
    v_fingerprint,
    v_status,
    v_normalized_summary,
    p_now
  )
  returning * into v_preflight;

  update public.ai_execution_jobs
     set result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'blocker', 'dispatch_not_enabled',
           'dispatch_preflight', v_normalized_summary,
           'dispatch_preflight_id', v_preflight.id,
           'dispatch_enabled', false,
           'no_messages_sent', true
         ),
         updated_at = p_now
   where id = v_job.id
     and status = 'waiting_input';

  if not found then
    raise exception 'campaign_preflight_state_changed'
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
    v_job.salon_id,
    'execution_worker',
    'campaign_dispatch_preflight_recorded',
    v_job.id,
    jsonb_build_object(
      'preflight_id', v_preflight.id,
      'manifest_id', v_manifest.id,
      'preflight_status', v_status,
      'preflight_fingerprint', v_fingerprint,
      'manifest_recipient_count', v_decision_count,
      'eligible_count', v_eligible_count,
      'sms_recipient_count', v_sms_count,
      'email_recipient_count', v_email_count,
      'estimated_cost_usd_cents', v_estimated_cost,
      'dispatch_enabled', false,
      'no_messages_sent', true
    ),
    p_now
  );

  return query
    select 'created'::text, v_preflight.id, v_status, v_fingerprint;
end;
$$;

revoke all on function public.record_ai_campaign_dispatch_preflight(
  uuid, uuid, jsonb, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_ai_campaign_dispatch_preflight(
  uuid, uuid, jsonb, jsonb, timestamptz
) to service_role;

comment on table public.ai_campaign_dispatch_preflights is
  'Append-only revalidation evidence for an approved campaign manifest; no outbound effect.';
comment on function public.record_ai_campaign_dispatch_preflight(
  uuid, uuid, jsonb, jsonb, timestamptz
) is
  'Records current consent/channel/cap checks while keeping live dispatch disabled.';

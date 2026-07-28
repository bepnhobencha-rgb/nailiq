-- Freeze the exact audience and message behind a second, explicit release
-- approval. This migration intentionally adds no outbound sender: approving a
-- release leaves its execution job waiting_input with dispatch_not_enabled.

create table public.ai_campaign_manifests (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  source_execution_job_id uuid not null
    references public.ai_execution_jobs(id) on delete cascade,
  source_approval_request_id uuid not null
    references public.approval_requests(id) on delete cascade,
  audience_fingerprint text not null
    check (audience_fingerprint ~ '^[0-9a-f]{24}$'),
  message_sha256 text not null
    check (message_sha256 ~ '^[0-9a-f]{64}$'),
  message text not null check (char_length(message) between 1 and 1000),
  summary jsonb not null,
  created_at timestamptz not null default now(),
  unique (source_execution_job_id, audience_fingerprint, message_sha256)
);

create table public.ai_campaign_manifest_recipients (
  manifest_id uuid not null
    references public.ai_campaign_manifests(id) on delete cascade,
  salon_id uuid not null references public.salons(id) on delete cascade,
  client_profile_id uuid not null
    references public.client_profiles(id) on delete restrict,
  sms boolean not null,
  email boolean not null,
  created_at timestamptz not null default now(),
  primary key (manifest_id, client_profile_id),
  check (sms or email)
);

create index ai_campaign_manifests_salon_created_idx
  on public.ai_campaign_manifests (salon_id, created_at desc);
create index ai_campaign_manifest_recipients_salon_idx
  on public.ai_campaign_manifest_recipients (salon_id, manifest_id);

alter table public.ai_campaign_manifests enable row level security;
alter table public.ai_campaign_manifest_recipients enable row level security;

revoke all on table public.ai_campaign_manifests
  from public, anon, authenticated;
revoke all on table public.ai_campaign_manifest_recipients
  from public, anon, authenticated;
grant all on table public.ai_campaign_manifests to service_role;
grant all on table public.ai_campaign_manifest_recipients to service_role;

create policy "service role manages campaign manifests"
  on public.ai_campaign_manifests
  for all to service_role
  using (true)
  with check (true);

create policy "service role manages campaign manifest recipients"
  on public.ai_campaign_manifest_recipients
  for all to service_role
  using (true)
  with check (true);

alter table public.approval_requests
  add column release_manifest_id uuid
    references public.ai_campaign_manifests(id) on delete set null;

create unique index approval_requests_release_manifest_idx
  on public.approval_requests (release_manifest_id)
  where release_manifest_id is not null;

create or replace function public.reject_ai_campaign_manifest_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Preserve normal salon deletion. A cascaded child delete runs nested inside
  -- the FK trigger; direct UPDATE/DELETE remains forbidden for every role.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;

  raise exception 'campaign_manifest_is_immutable'
    using errcode = '55000';
end;
$$;

create trigger ai_campaign_manifests_immutable
  before update or delete on public.ai_campaign_manifests
  for each row execute function public.reject_ai_campaign_manifest_mutation();

create trigger ai_campaign_manifest_recipients_immutable
  before update or delete on public.ai_campaign_manifest_recipients
  for each row execute function public.reject_ai_campaign_manifest_mutation();

revoke all on function public.reject_ai_campaign_manifest_mutation()
  from public, anon, authenticated;

create or replace function public.record_ai_campaign_manifest(
  p_job_id uuid,
  p_salon_id uuid,
  p_summary jsonb,
  p_recipients jsonb,
  p_now timestamptz
)
returns table (
  outcome text,
  manifest_id uuid,
  release_approval_id uuid,
  audience_fingerprint text,
  message_sha256 text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.ai_execution_jobs%rowtype;
  v_manifest public.ai_campaign_manifests%rowtype;
  v_release_approval_id uuid;
  v_message text;
  v_message_sha256 text;
  v_fingerprint text;
  v_recipient_count integer;
  v_unique_count integer;
  v_sms_count integer;
  v_email_count integer;
  v_dual_count integer;
  v_normalized_summary jsonb;
begin
  if jsonb_typeof(p_summary) <> 'object'
     or jsonb_typeof(p_recipients) <> 'array'
     or p_summary ->> 'segment' <> 'lapsed_regulars_45_365_days'
     or p_summary ->> 'no_messages_sent' <> 'true'
     or coalesce(p_summary ->> 'audience_fingerprint', '') !~ '^[0-9a-f]{24}$'
     or coalesce(p_summary ->> 'candidate_count', '') !~ '^[0-9]+$'
     or coalesce(p_summary ->> 'eligible_count', '') !~ '^[0-9]+$'
     or coalesce(p_summary ->> 'sms_recipient_count', '') !~ '^[0-9]+$'
     or coalesce(p_summary ->> 'email_recipient_count', '') !~ '^[0-9]+$'
     or coalesce(p_summary ->> 'dual_channel_count', '') !~ '^[0-9]+$'
     or (p_summary ->> 'candidate_count')::integer > 500
     or (p_summary ->> 'eligible_count')::integer > 500
     or (p_summary ->> 'eligible_count')::integer >
        (p_summary ->> 'candidate_count')::integer
     or jsonb_array_length(p_recipients) > 500 then
    return query
      select 'invalid_manifest'::text, null::uuid, null::uuid,
             null::text, null::text;
    return;
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_recipients) item
     where jsonb_typeof(item) <> 'object'
        or coalesce(item ->> 'client_profile_id', '') !~
           '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        or jsonb_typeof(item -> 'sms') <> 'boolean'
        or jsonb_typeof(item -> 'email') <> 'boolean'
        or not (
          coalesce((item ->> 'sms')::boolean, false)
          or coalesce((item ->> 'email')::boolean, false)
        )
  ) then
    return query
      select 'invalid_recipients'::text, null::uuid, null::uuid,
             null::text, null::text;
    return;
  end if;

  select
    count(*)::integer,
    count(distinct (item ->> 'client_profile_id'))::integer,
    count(*) filter (where (item ->> 'sms')::boolean)::integer,
    count(*) filter (where (item ->> 'email')::boolean)::integer,
    count(*) filter (
      where (item ->> 'sms')::boolean and (item ->> 'email')::boolean
    )::integer,
    left(
      encode(
        extensions.digest(
          convert_to(
            coalesce(
              string_agg(
                lower(item ->> 'client_profile_id') || ':' ||
                case when (item ->> 'sms')::boolean then 's' else '' end ||
                case when (item ->> 'email')::boolean then 'e' else '' end,
                '|' order by lower(item ->> 'client_profile_id')
              ),
              ''
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ),
      24
    )
    into v_recipient_count, v_unique_count, v_sms_count, v_email_count,
         v_dual_count, v_fingerprint
    from jsonb_array_elements(p_recipients) item;

  if v_recipient_count <> v_unique_count
     or v_recipient_count <> (p_summary ->> 'eligible_count')::integer
     or v_sms_count <> (p_summary ->> 'sms_recipient_count')::integer
     or v_email_count <> (p_summary ->> 'email_recipient_count')::integer
     or v_dual_count <> (p_summary ->> 'dual_channel_count')::integer
     or v_fingerprint <> p_summary ->> 'audience_fingerprint' then
    return query
      select 'manifest_mismatch'::text, null::uuid, null::uuid,
             v_fingerprint, null::text;
    return;
  end if;

  select *
    into v_job
    from public.ai_execution_jobs
   where id = p_job_id
     and salon_id = p_salon_id
     and action_type = 'bulk_message'
   for update;

  if not found
     or v_job.status <> 'waiting_input'
     or coalesce(v_job.result ->> 'blocker', '') not in (
       'recipient_selection_required',
       'release_approval_required'
     ) then
    return query
      select 'job_not_preparable'::text, null::uuid, null::uuid,
             null::text, null::text;
    return;
  end if;

  v_message := btrim(coalesce(v_job.payload ->> 'message', ''));
  if char_length(v_message) not between 1 and 1000 then
    return query
      select 'invalid_message'::text, null::uuid, null::uuid,
             null::text, null::text;
    return;
  end if;
  v_message_sha256 := encode(
    extensions.digest(convert_to(v_message, 'UTF8'), 'sha256'),
    'hex'
  );

  select *
    into v_manifest
    from public.ai_campaign_manifests m
   where m.source_execution_job_id = v_job.id
     and m.audience_fingerprint = v_fingerprint
     and m.message_sha256 = v_message_sha256;

  if found then
    select ar.id
      into v_release_approval_id
      from public.approval_requests ar
     where ar.release_manifest_id = v_manifest.id;

    return query
      select 'unchanged'::text, v_manifest.id, v_release_approval_id,
             v_fingerprint, v_message_sha256;
    return;
  end if;

  v_normalized_summary := p_summary || jsonb_build_object(
    'prepared_at', p_now,
    'no_messages_sent', true
  );

  -- Only the latest snapshot remains actionable. Older manifests remain
  -- append-only evidence; any still-pending release approval expires.
  update public.approval_requests ar
     set status = 'expired'
   where ar.status = 'pending'
     and ar.release_manifest_id in (
       select m.id
         from public.ai_campaign_manifests m
        where m.source_execution_job_id = v_job.id
     );

  insert into public.ai_campaign_manifests (
    salon_id,
    source_execution_job_id,
    source_approval_request_id,
    audience_fingerprint,
    message_sha256,
    message,
    summary,
    created_at
  ) values (
    v_job.salon_id,
    v_job.id,
    v_job.approval_request_id,
    v_fingerprint,
    v_message_sha256,
    v_message,
    v_normalized_summary,
    p_now
  )
  returning * into v_manifest;

  insert into public.ai_campaign_manifest_recipients (
    manifest_id,
    salon_id,
    client_profile_id,
    sms,
    email,
    created_at
  )
  select
    v_manifest.id,
    v_job.salon_id,
    (item ->> 'client_profile_id')::uuid,
    (item ->> 'sms')::boolean,
    (item ->> 'email')::boolean,
    p_now
  from jsonb_array_elements(p_recipients) item;

  insert into public.approval_requests (
    salon_id,
    action_type,
    summary,
    payload,
    urgency,
    status,
    expires_at,
    release_manifest_id,
    created_at
  ) values (
    v_job.salon_id,
    'bulk_message',
    'Release consent-checked campaign to ' || v_recipient_count::text ||
      ' eligible customers.',
    jsonb_build_object(
      'proposal_source', 'campaign_release_gate',
      'manifest_id', v_manifest.id,
      'source_execution_job_id', v_job.id,
      'audience_fingerprint', v_fingerprint,
      'message_sha256', v_message_sha256,
      'message', v_message,
      'eligible_count', v_recipient_count,
      'sms_recipient_count', v_sms_count,
      'email_recipient_count', v_email_count,
      'dual_channel_count', v_dual_count,
      'estimated_cost_usd_cents',
        v_normalized_summary -> 'estimated_cost_usd_cents',
      'recipient_selection_required', false,
      'dispatch_enabled', false,
      'dispatch_authorization_required', true,
      'no_messages_sent', true
    ),
    'normal',
    'pending',
    p_now + interval '72 hours',
    v_manifest.id,
    p_now
  )
  returning id into v_release_approval_id;

  update public.ai_execution_jobs
     set result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'blocker', 'release_approval_required',
           'audience_preparation', v_normalized_summary,
           'campaign_manifest_id', v_manifest.id,
           'release_approval_id', v_release_approval_id,
           'dispatch_enabled', false,
           'no_messages_sent', true
         ),
         updated_at = p_now
   where id = v_job.id
     and status = 'waiting_input';

  if not found then
    raise exception 'campaign_manifest_state_changed'
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
    'campaign_manifest_prepared',
    v_job.id,
    jsonb_build_object(
      'manifest_id', v_manifest.id,
      'release_approval_id', v_release_approval_id,
      'audience_fingerprint', v_fingerprint,
      'message_sha256', v_message_sha256,
      'eligible_count', v_recipient_count,
      'sms_recipient_count', v_sms_count,
      'email_recipient_count', v_email_count,
      'no_messages_sent', true
    ),
    p_now
  );

  return query
    select 'created'::text, v_manifest.id, v_release_approval_id,
           v_fingerprint, v_message_sha256;
end;
$$;

revoke all on function public.record_ai_campaign_manifest(
  uuid, uuid, jsonb, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_ai_campaign_manifest(
  uuid, uuid, jsonb, jsonb, timestamptz
) to service_role;

comment on table public.ai_campaign_manifests is
  'Append-only exact campaign audience/message snapshot; service-role only.';
comment on table public.ai_campaign_manifest_recipients is
  'Consent-checked profile/channel decisions for one immutable campaign manifest; no destination PII.';
comment on function public.record_ai_campaign_manifest(
  uuid, uuid, jsonb, jsonb, timestamptz
) is
  'Atomically freezes an audience, creates the final release approval, and sends nothing.';

-- Approval decisions now distinguish missing audience inputs from an exact
-- release that is approved but still lacks an intentionally absent dispatcher.
create or replace function public.decide_ai_approval_request(
  p_token text,
  p_decision text
)
returns table (
  outcome text,
  approval_id uuid,
  salon_id uuid,
  action_type text,
  decision_status text,
  execution_job_id uuid,
  execution_status text,
  decided_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request public.approval_requests%rowtype;
  v_job public.ai_execution_jobs%rowtype;
  v_now timestamptz := statement_timestamp();
  v_initial_status text;
  v_blocker text;
begin
  if p_decision not in ('approved', 'declined') then
    return query
      select 'invalid_decision'::text, null::uuid, null::uuid, null::text,
             null::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  select *
    into v_request
    from public.approval_requests ar
   where (
     p_decision = 'approved'
     and ar.approve_token = p_token
   ) or (
     p_decision = 'declined'
     and ar.decline_token = p_token
   )
   for update;

  if not found then
    return query
      select 'not_found'::text, null::uuid, null::uuid, null::text,
             null::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  if v_request.status = 'pending' and v_request.expires_at < v_now then
    update public.approval_requests
       set status = 'expired'
     where id = v_request.id;

    return query
      select 'expired'::text, v_request.id, v_request.salon_id,
             v_request.action_type, 'expired'::text, null::uuid, null::text,
             null::timestamptz;
    return;
  end if;

  if v_request.status = 'pending' then
    update public.approval_requests
       set status = p_decision,
           decided_at = v_now
     where id = v_request.id;

    if p_decision = 'declined' then
      insert into public.ai_actions_log (
        salon_id, agent, action_type, target_id, payload
      ) values (
        v_request.salon_id,
        'ai_approval',
        'approval_declined',
        v_request.id,
        jsonb_build_object(
          'approval_request_id', v_request.id,
          'requested_action_type', v_request.action_type
        )
      );

      return query
        select 'declined'::text, v_request.id, v_request.salon_id,
               v_request.action_type, 'declined'::text, null::uuid, null::text,
               v_now;
      return;
    end if;

    v_blocker := case
      when v_request.payload ->> 'recipient_selection_required' = 'true'
        then 'recipient_selection_required'
      when v_request.payload ->> 'dispatch_enabled' <> 'true'
        then 'dispatch_not_enabled'
      else null
    end;
    v_initial_status := case when v_blocker is null then 'queued'
                             else 'waiting_input' end;

    insert into public.ai_execution_jobs (
      salon_id, approval_request_id, action_type, payload, status,
      idempotency_key, result, updated_at
    ) values (
      v_request.salon_id,
      v_request.id,
      v_request.action_type,
      v_request.payload,
      v_initial_status,
      'approval:' || v_request.id::text,
      case when v_blocker is null then null
           else jsonb_build_object('blocker', v_blocker) end,
      v_now
    )
    returning * into v_job;

    insert into public.ai_actions_log (
      salon_id, agent, action_type, target_id, payload
    ) values (
      v_request.salon_id,
      'ai_approval',
      'approval_approved_queued',
      v_request.id,
      jsonb_build_object(
        'approval_request_id', v_request.id,
        'execution_job_id', v_job.id,
        'execution_status', v_job.status,
        'execution_blocker', v_blocker,
        'requested_action_type', v_request.action_type
      )
    );

    return query
      select 'approved_queued'::text, v_request.id, v_request.salon_id,
             v_request.action_type, 'approved'::text, v_job.id, v_job.status,
             v_now;
    return;
  end if;

  if v_request.status = 'approved' and p_decision = 'approved' then
    select *
      into v_job
      from public.ai_execution_jobs
     where approval_request_id = v_request.id;

    if not found then
      v_blocker := case
        when v_request.payload ->> 'recipient_selection_required' = 'true'
          then 'recipient_selection_required'
        when v_request.payload ->> 'dispatch_enabled' <> 'true'
          then 'dispatch_not_enabled'
        else null
      end;
      v_initial_status := case when v_blocker is null then 'queued'
                               else 'waiting_input' end;

      insert into public.ai_execution_jobs (
        salon_id, approval_request_id, action_type, payload, status,
        idempotency_key, result, updated_at
      ) values (
        v_request.salon_id,
        v_request.id,
        v_request.action_type,
        v_request.payload,
        v_initial_status,
        'approval:' || v_request.id::text,
        case when v_blocker is null then null
             else jsonb_build_object('blocker', v_blocker) end,
        v_now
      )
      on conflict (approval_request_id) do nothing
      returning * into v_job;

      if v_job.id is null then
        select *
          into v_job
          from public.ai_execution_jobs
         where approval_request_id = v_request.id;
      else
        insert into public.ai_actions_log (
          salon_id, agent, action_type, target_id, payload
        ) values (
          v_request.salon_id,
          'ai_approval',
          'approval_execution_recovered',
          v_request.id,
          jsonb_build_object(
            'approval_request_id', v_request.id,
            'execution_job_id', v_job.id,
            'execution_status', v_job.status,
            'execution_blocker', v_blocker,
            'requested_action_type', v_request.action_type
          )
        );

        return query
          select 'approved_recovered'::text, v_request.id, v_request.salon_id,
                 v_request.action_type, 'approved'::text, v_job.id,
                 v_job.status, v_request.decided_at;
        return;
      end if;
    end if;

    return query
      select 'already_decided'::text, v_request.id, v_request.salon_id,
             v_request.action_type, v_request.status, v_job.id, v_job.status,
             v_request.decided_at;
    return;
  end if;

  return query
    select 'already_decided'::text, v_request.id, v_request.salon_id,
           v_request.action_type, v_request.status, null::uuid, null::text,
           v_request.decided_at;
end;
$$;

revoke all on function public.decide_ai_approval_request(text, text)
  from public, anon, authenticated;
grant execute on function public.decide_ai_approval_request(text, text)
  to service_role;

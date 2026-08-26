-- Product-approved MQA-0181 boundary:
-- * win-back/rebook runners create dashboard-only bilingual drafts;
-- * the runner never calls an AI or outbound provider and never reads recipients;
-- * one draft per salon/kind/week is created atomically;
-- * owner/admin may edit the exact EN/VI copy before first approval;
-- * audience preparation is a separate consent-aware dry run;
-- * an immutable audience/message manifest requires a second approval;
-- * dispatch remains hard-disabled and there is no post-send undo claim.

create table public.reactivation_campaign_draft_claims (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  campaign_kind text not null check (campaign_kind in ('winback', 'rebook')),
  period_key date not null,
  approval_request_id uuid references public.approval_requests(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  unique (salon_id, campaign_kind, period_key)
);

comment on table public.reactivation_campaign_draft_claims is
  'PII-free once-per-week claim for dashboard-only reactivation campaign drafts.';

create index reactivation_campaign_draft_claims_salon_period_idx
  on public.reactivation_campaign_draft_claims
    (salon_id, campaign_kind, period_key desc);

alter table public.reactivation_campaign_draft_claims enable row level security;
alter table public.reactivation_campaign_draft_claims force row level security;
revoke all on table public.reactivation_campaign_draft_claims
  from public, anon, authenticated;
grant all on table public.reactivation_campaign_draft_claims to service_role;

alter table public.approval_requests
  add column reactivation_campaign_claim_id uuid
    references public.reactivation_campaign_draft_claims(id) on delete set null;

create unique index approval_requests_reactivation_campaign_claim_unique
  on public.approval_requests (reactivation_campaign_claim_id)
  where reactivation_campaign_claim_id is not null;

create or replace function public.create_reactivation_campaign_draft(
  p_salon_id uuid,
  p_campaign_kind text,
  p_period_key date,
  p_title text,
  p_message_en text,
  p_message_vi text
)
returns table (outcome text, approval_request_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_claim public.reactivation_campaign_draft_claims%rowtype;
  v_approval_id uuid;
  v_title text := btrim(coalesce(p_title, ''));
  v_en text := btrim(coalesce(p_message_en, ''));
  v_vi text := btrim(coalesce(p_message_vi, ''));
begin
  if p_salon_id is null
     or p_campaign_kind not in ('winback', 'rebook')
     or p_period_key is null
     or char_length(v_title) not between 3 and 120
     or char_length(v_en) not between 20 and 480
     or char_length(v_vi) not between 20 and 480
     or v_en ~* '(https?://|www\.|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,})'
     or v_vi ~* '(https?://|www\.|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,})'
     or v_en ~* '\m(?:discount|percent|refund|guarantee|free)\M'
     or v_vi ~* '\m(?:giảm[[:space:]]*giá|phần[[:space:]]*trăm|hoàn[[:space:]]*tiền|miễn[[:space:]]*phí)\M'
     or v_en ~ '[%$]'
     or v_vi ~ '[%$]' then
    return query select 'invalid_draft'::text, null::uuid;
    return;
  end if;

  insert into public.reactivation_campaign_draft_claims (
    salon_id, campaign_kind, period_key
  ) values (
    p_salon_id, p_campaign_kind, p_period_key
  )
  on conflict (salon_id, campaign_kind, period_key) do nothing
  returning * into v_claim;

  if not found then
    select * into v_claim
      from public.reactivation_campaign_draft_claims claim
     where claim.salon_id = p_salon_id
       and claim.campaign_kind = p_campaign_kind
       and claim.period_key = p_period_key
     for update;

    return query
      select case when v_claim.approval_request_id is null
                    then 'in_progress' else 'existing' end,
             v_claim.approval_request_id;
    return;
  end if;

  insert into public.approval_requests (
    salon_id,
    action_type,
    summary,
    payload,
    urgency,
    expires_at,
    reactivation_campaign_claim_id
  ) values (
    p_salon_id,
    'bulk_message',
    left(v_title || ': ' || v_en, 1000),
    jsonb_build_object(
      'proposal_source', 'reactivation_campaign',
      'proposal_type', 'reactivation_campaign_draft',
      'reactivation_kind', p_campaign_kind,
      'title', v_title,
      'message_en', v_en,
      'message_vi', v_vi,
      'message', 'English: ' || v_en || E'\nTiếng Việt: ' || v_vi,
      'language_routing_required', true,
      'campaign_mode', 'dashboard_draft_only',
      'notification_mode', 'dashboard_only_no_email',
      'execution_mode', 'owner_review_then_audience_release',
      'delivery_mode', 'no_dispatch',
      'dispatch_enabled', false,
      'recipient_selection_required', true,
      'audience_status', 'not_prepared',
      'owner_configuration_required', true,
      'reversible', false,
      'no_messages_sent', true
    ),
    'normal',
    v_now + interval '7 days',
    v_claim.id
  )
  returning id into v_approval_id;

  update public.reactivation_campaign_draft_claims
     set approval_request_id = v_approval_id
   where id = v_claim.id;

  return query select 'created'::text, v_approval_id;
end;
$$;

create or replace function public.update_reactivation_campaign_draft_as_actor(
  p_approval_id uuid,
  p_actor_user_id uuid,
  p_message_en text,
  p_message_vi text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_approval public.approval_requests%rowtype;
  v_en text := btrim(coalesce(p_message_en, ''));
  v_vi text := btrim(coalesce(p_message_vi, ''));
begin
  select * into v_approval
    from public.approval_requests
   where id = p_approval_id
   for update;

  if not found
     or v_approval.action_type <> 'bulk_message'
     or v_approval.payload ->> 'proposal_source' <> 'reactivation_campaign'
     or v_approval.payload ->> 'campaign_mode' <> 'dashboard_draft_only' then
    return 'not_found';
  end if;
  if v_approval.status <> 'pending' then return 'already_decided'; end if;
  if v_approval.expires_at <= v_now then return 'expired'; end if;

  if p_actor_user_id is null or not exists (
    select 1
      from public.salon_members member
     where member.salon_id = v_approval.salon_id
       and member.user_id = p_actor_user_id
       and member.role in ('owner', 'admin')
  ) then
    return 'forbidden';
  end if;

  if char_length(v_en) not between 20 and 480
     or char_length(v_vi) not between 20 and 480
     or v_en ~* '(https?://|www\.|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,})'
     or v_vi ~* '(https?://|www\.|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,})'
     or v_en ~* '\m(?:discount|percent|refund|guarantee|free)\M'
     or v_vi ~* '\m(?:giảm[[:space:]]*giá|phần[[:space:]]*trăm|hoàn[[:space:]]*tiền|miễn[[:space:]]*phí)\M'
     or v_en ~ '[%$]'
     or v_vi ~ '[%$]' then
    return 'invalid_draft';
  end if;

  update public.approval_requests
     set summary = left(
           coalesce(nullif(v_approval.payload ->> 'title', ''), 'Reactivation draft')
           || ': ' || v_en,
           1000
         ),
         payload = jsonb_set(
           jsonb_set(
             jsonb_set(
               jsonb_set(
                 v_approval.payload,
                 '{message_en}', to_jsonb(v_en), true
               ),
               '{message_vi}', to_jsonb(v_vi), true
             ),
             '{message}',
             to_jsonb('English: ' || v_en || E'\nTiếng Việt: ' || v_vi),
             true
           ),
           '{owner_edited_at}', to_jsonb(v_now::text), true
         )
   where id = v_approval.id;

  return 'updated';
end;
$$;

-- Candidate superset for a rebook audience dry run. It deliberately performs
-- no consent filtering; the application re-evaluates both legacy and current
-- per-channel preferences immediately before freezing the manifest.
create or replace function public.marketing_rebook_audience_candidates(
  p_salon_id uuid,
  p_min_visits integer default 3,
  p_lookahead_days integer default 14,
  p_overdue_days integer default 30,
  p_limit integer default 500
)
returns table (
  client_phone text,
  client_name text,
  client_email text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with visit_days as (
    select b.client_phone, (b.start_time_utc at time zone 'UTC')::date as visit_day
      from public.bookings b
     where b.salon_id = p_salon_id
       and coalesce(b.client_phone, '') <> ''
       and b.start_time_utc < statement_timestamp()
       and b.status not in ('cancelled', 'pending')
     group by b.client_phone, (b.start_time_utc at time zone 'UTC')::date
  ),
  gaps as (
    select client_phone, visit_day,
           visit_day - lag(visit_day) over (
             partition by client_phone order by visit_day
           ) as gap
      from visit_days
  ),
  aggregate_visits as (
    select client_phone,
           count(*)::integer as visit_count,
           max(visit_day) as last_visit,
           percentile_cont(0.5) within group (order by gap)
             filter (where gap between 1 and 183) as cadence
      from gaps
     group by client_phone
  )
  select
    visits.client_phone,
    coalesce(profile.name, 'Guest') as client_name,
    profile.email as client_email
  from aggregate_visits visits
  left join public.client_profiles profile
    on profile.phone = visits.client_phone
   and profile.deleted_at is null
  where visits.visit_count >= greatest(1, least(coalesce(p_min_visits, 3), 20))
    and visits.cadence is not null
    and visits.last_visit + round(visits.cadence)::integer
      <= current_date + greatest(0, least(coalesce(p_lookahead_days, 14), 60))
    and visits.last_visit + round(visits.cadence)::integer
      >= current_date - greatest(0, least(coalesce(p_overdue_days, 30), 180))
    and not exists (
      select 1
        from public.bookings future_booking
       where future_booking.salon_id = p_salon_id
         and future_booking.client_phone = visits.client_phone
         and future_booking.status in ('confirmed', 'pending')
         and future_booking.start_time_utc > statement_timestamp()
    )
  order by visits.last_visit + round(visits.cadence)::integer,
           visits.client_phone
  limit greatest(1, least(coalesce(p_limit, 500), 500));
$$;

create or replace function public.record_reactivation_campaign_manifest(
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
  v_kind text;
  v_expected_segment text;
  v_message_en text;
  v_message_vi text;
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
  if jsonb_typeof(p_summary) is distinct from 'object'
     or jsonb_typeof(p_recipients) is distinct from 'array'
     or p_summary ->> 'segment' not in (
       'winback_lapsed_regulars_45_365_days',
       'rebook_due_regulars'
     )
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
    return query select 'invalid_manifest'::text, null::uuid, null::uuid,
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
    return query select 'invalid_recipients'::text, null::uuid, null::uuid,
                        null::text, null::text;
    return;
  end if;

  select count(*)::integer,
         count(distinct (item ->> 'client_profile_id'))::integer,
         count(*) filter (where (item ->> 'sms')::boolean)::integer,
         count(*) filter (where (item ->> 'email')::boolean)::integer,
         count(*) filter (
           where (item ->> 'sms')::boolean and (item ->> 'email')::boolean
         )::integer,
         left(encode(extensions.digest(convert_to(coalesce(string_agg(
           lower(item ->> 'client_profile_id') || ':' ||
           case when (item ->> 'sms')::boolean then 's' else '' end ||
           case when (item ->> 'email')::boolean then 'e' else '' end,
           '|' order by lower(item ->> 'client_profile_id')), ''), 'UTF8'),
           'sha256'), 'hex'), 24)
    into v_recipient_count, v_unique_count, v_sms_count, v_email_count,
         v_dual_count, v_fingerprint
    from jsonb_array_elements(p_recipients) item;

  if v_recipient_count <> v_unique_count
     or v_recipient_count <> (p_summary ->> 'eligible_count')::integer
     or v_sms_count <> (p_summary ->> 'sms_recipient_count')::integer
     or v_email_count <> (p_summary ->> 'email_recipient_count')::integer
     or v_dual_count <> (p_summary ->> 'dual_channel_count')::integer
     or v_fingerprint <> p_summary ->> 'audience_fingerprint' then
    return query select 'manifest_mismatch'::text, null::uuid, null::uuid,
                        v_fingerprint, null::text;
    return;
  end if;

  select * into v_job
    from public.ai_execution_jobs
   where id = p_job_id
     and salon_id = p_salon_id
     and action_type = 'bulk_message'
   for update;

  if not found
     or v_job.status <> 'waiting_input'
     or v_job.payload ->> 'proposal_source' <> 'reactivation_campaign'
     or coalesce(v_job.result ->> 'blocker', '') not in (
       'recipient_selection_required', 'release_approval_required'
     ) then
    return query select 'job_not_preparable'::text, null::uuid, null::uuid,
                        null::text, null::text;
    return;
  end if;

  v_kind := v_job.payload ->> 'reactivation_kind';
  v_expected_segment := case v_kind
    when 'winback' then 'winback_lapsed_regulars_45_365_days'
    when 'rebook' then 'rebook_due_regulars'
    else null
  end;
  if v_expected_segment is null
     or p_summary ->> 'segment' is distinct from v_expected_segment then
    return query select 'segment_mismatch'::text, null::uuid, null::uuid,
                        null::text, null::text;
    return;
  end if;

  v_message_en := btrim(coalesce(v_job.payload ->> 'message_en', ''));
  v_message_vi := btrim(coalesce(v_job.payload ->> 'message_vi', ''));
  if char_length(v_message_en) not between 20 and 480
     or char_length(v_message_vi) not between 20 and 480 then
    return query select 'invalid_message'::text, null::uuid, null::uuid,
                        null::text, null::text;
    return;
  end if;
  v_message := jsonb_build_object('en', v_message_en, 'vi', v_message_vi)::text;
  v_message_sha256 := encode(
    extensions.digest(convert_to(v_message, 'UTF8'), 'sha256'), 'hex'
  );

  select * into v_manifest
    from public.ai_campaign_manifests manifest
   where manifest.source_execution_job_id = v_job.id
     and manifest.audience_fingerprint = v_fingerprint
     and manifest.message_sha256 = v_message_sha256;

  if found then
    select request.id into v_release_approval_id
      from public.approval_requests request
     where request.release_manifest_id = v_manifest.id;
    return query select 'unchanged'::text, v_manifest.id,
                        v_release_approval_id, v_fingerprint,
                        v_message_sha256;
    return;
  end if;

  v_normalized_summary := p_summary || jsonb_build_object(
    'prepared_at', p_now,
    'reactivation_kind', v_kind,
    'language_routing_required', true,
    'no_messages_sent', true
  );

  update public.approval_requests request
     set status = 'expired'
   where request.status = 'pending'
     and request.release_manifest_id in (
       select manifest.id
         from public.ai_campaign_manifests manifest
        where manifest.source_execution_job_id = v_job.id
     );

  insert into public.ai_campaign_manifests (
    salon_id, source_execution_job_id, source_approval_request_id,
    audience_fingerprint, message_sha256, message, summary, created_at
  ) values (
    v_job.salon_id, v_job.id, v_job.approval_request_id,
    v_fingerprint, v_message_sha256, v_message, v_normalized_summary, p_now
  ) returning * into v_manifest;

  insert into public.ai_campaign_manifest_recipients (
    manifest_id, salon_id, client_profile_id, sms, email, created_at
  )
  select v_manifest.id, v_job.salon_id,
         (item ->> 'client_profile_id')::uuid,
         (item ->> 'sms')::boolean,
         (item ->> 'email')::boolean,
         p_now
    from jsonb_array_elements(p_recipients) item;

  insert into public.approval_requests (
    salon_id, action_type, summary, payload, urgency, status, expires_at,
    release_manifest_id, created_at
  ) values (
    v_job.salon_id,
    'bulk_message',
    'Release ' || v_kind || ' campaign to ' || v_recipient_count::text ||
      ' consent-checked customers.',
    jsonb_build_object(
      'proposal_source', 'reactivation_campaign_release_gate',
      'reactivation_kind', v_kind,
      'manifest_id', v_manifest.id,
      'source_execution_job_id', v_job.id,
      'audience_fingerprint', v_fingerprint,
      'message_sha256', v_message_sha256,
      'message_en', v_message_en,
      'message_vi', v_message_vi,
      'eligible_count', v_recipient_count,
      'sms_recipient_count', v_sms_count,
      'email_recipient_count', v_email_count,
      'dual_channel_count', v_dual_count,
      'estimated_cost_usd_cents',
        v_normalized_summary -> 'estimated_cost_usd_cents',
      'notification_mode', 'dashboard_only_no_email',
      'recipient_selection_required', false,
      'language_routing_required', true,
      'dispatch_enabled', false,
      'dispatch_authorization_required', true,
      'no_messages_sent', true,
      'reversible', false
    ),
    'normal', 'pending', p_now + interval '72 hours', v_manifest.id, p_now
  ) returning id into v_release_approval_id;

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
    raise exception 'reactivation_campaign_manifest_state_changed'
      using errcode = '40001';
  end if;

  insert into public.ai_actions_log (
    salon_id, agent, action_type, target_id, payload, created_at
  ) values (
    v_job.salon_id,
    'execution_worker',
    'reactivation_campaign_manifest_prepared',
    v_job.id,
    jsonb_build_object(
      'manifest_id', v_manifest.id,
      'release_approval_id', v_release_approval_id,
      'reactivation_kind', v_kind,
      'audience_fingerprint', v_fingerprint,
      'message_sha256', v_message_sha256,
      'eligible_count', v_recipient_count,
      'sms_recipient_count', v_sms_count,
      'email_recipient_count', v_email_count,
      'no_messages_sent', true
    ),
    p_now
  );

  return query select 'created'::text, v_manifest.id,
                      v_release_approval_id, v_fingerprint,
                      v_message_sha256;
end;
$$;

revoke all on function public.create_reactivation_campaign_draft(
  uuid, text, date, text, text, text
) from public, anon, authenticated;
revoke all on function public.update_reactivation_campaign_draft_as_actor(
  uuid, uuid, text, text
) from public, anon, authenticated;
revoke all on function public.marketing_rebook_audience_candidates(
  uuid, integer, integer, integer, integer
) from public, anon, authenticated;
revoke all on function public.record_reactivation_campaign_manifest(
  uuid, uuid, jsonb, jsonb, timestamptz
) from public, anon, authenticated;

grant execute on function public.create_reactivation_campaign_draft(
  uuid, text, date, text, text, text
) to service_role;
grant execute on function public.update_reactivation_campaign_draft_as_actor(
  uuid, uuid, text, text
) to service_role;
grant execute on function public.marketing_rebook_audience_candidates(
  uuid, integer, integer, integer, integer
) to service_role;
grant execute on function public.record_reactivation_campaign_manifest(
  uuid, uuid, jsonb, jsonb, timestamptz
) to service_role;

comment on function public.record_reactivation_campaign_manifest(
  uuid, uuid, jsonb, jsonb, timestamptz
) is
  'Atomically freezes an EN/VI reactivation message and consent-checked audience, creates a second approval, and sends nothing.';

-- Product-approved MQA-0179 boundary:
-- * weekly promo ideas are opt-in, dashboard-only drafts;
-- * no automatic email/SMS/social post, promotion mutation or dispatch;
-- * AI output cannot introduce numeric offer facts;
-- * owner/admin may add numeric facts only with an explicit confirmation;
-- * claim the salon/source/week atomically before any provider call.

create table public.promo_campaign_draft_claims (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  source text not null check (source = 'weekly_strategist'),
  period_key date not null,
  status text not null default 'processing'
    check (status in ('processing', 'drafted', 'failed')),
  attempt_count integer not null default 1
    check (attempt_count between 1 and 3),
  claim_token uuid not null default gen_random_uuid(),
  lease_expires_at timestamptz not null default (statement_timestamp() + interval '10 minutes'),
  approval_request_id uuid references public.approval_requests(id) on delete set null,
  failure_code text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (salon_id, source, period_key)
);

comment on table public.promo_campaign_draft_claims is
  'PII-free atomic claim and bounded retry evidence for dashboard-only promo campaign drafts.';

create index promo_campaign_draft_claims_salon_status_period_idx
  on public.promo_campaign_draft_claims (salon_id, status, period_key desc);

alter table public.promo_campaign_draft_claims enable row level security;
alter table public.promo_campaign_draft_claims force row level security;
revoke all on table public.promo_campaign_draft_claims
  from public, anon, authenticated;
grant all on table public.promo_campaign_draft_claims to service_role;

alter table public.approval_requests
  add column promo_campaign_claim_id uuid
    references public.promo_campaign_draft_claims(id) on delete set null;

create unique index approval_requests_promo_campaign_claim_unique
  on public.approval_requests (promo_campaign_claim_id)
  where promo_campaign_claim_id is not null;

create or replace function public.claim_promo_campaign_draft(
  p_salon_id uuid,
  p_source text,
  p_period_key date
)
returns table (
  outcome text,
  claim_id uuid,
  claim_token uuid,
  attempt_count integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_claim public.promo_campaign_draft_claims%rowtype;
begin
  if p_salon_id is null
     or p_source is distinct from 'weekly_strategist'
     or p_period_key is null then
    return query select 'invalid'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;

  insert into public.promo_campaign_draft_claims (
    salon_id,
    source,
    period_key,
    status,
    attempt_count,
    lease_expires_at,
    updated_at
  ) values (
    p_salon_id,
    p_source,
    p_period_key,
    'processing',
    1,
    v_now + interval '10 minutes',
    v_now
  )
  on conflict (salon_id, source, period_key) do nothing
  returning * into v_claim;

  if found then
    return query
      select 'claimed'::text, v_claim.id, v_claim.claim_token,
             v_claim.attempt_count;
    return;
  end if;

  select * into v_claim
    from public.promo_campaign_draft_claims
   where salon_id = p_salon_id
     and source = p_source
     and period_key = p_period_key
   for update;

  if v_claim.status = 'drafted' then
    return query
      select 'existing'::text, v_claim.id, null::uuid,
             v_claim.attempt_count;
    return;
  end if;

  if v_claim.status = 'processing' and v_claim.lease_expires_at > v_now then
    return query
      select 'in_progress'::text, v_claim.id, null::uuid,
             v_claim.attempt_count;
    return;
  end if;

  if v_claim.attempt_count >= 3 then
    return query
      select 'exhausted'::text, v_claim.id, null::uuid,
             v_claim.attempt_count;
    return;
  end if;

  update public.promo_campaign_draft_claims as claim
     set status = 'processing',
         attempt_count = claim.attempt_count + 1,
         claim_token = gen_random_uuid(),
         lease_expires_at = v_now + interval '10 minutes',
         failure_code = null,
         updated_at = v_now
   where claim.id = v_claim.id
  returning * into v_claim;

  return query
    select 'claimed'::text, v_claim.id, v_claim.claim_token,
           v_claim.attempt_count;
end;
$$;

create or replace function public.complete_promo_campaign_draft(
  p_claim_id uuid,
  p_claim_token uuid,
  p_title text,
  p_reasoning text,
  p_draft_message text,
  p_language text,
  p_evidence jsonb
)
returns table (outcome text, approval_request_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_claim public.promo_campaign_draft_claims%rowtype;
  v_approval_id uuid;
  v_title text := btrim(coalesce(p_title, ''));
  v_reasoning text := btrim(coalesce(p_reasoning, ''));
  v_message text := btrim(coalesce(p_draft_message, ''));
begin
  select * into v_claim
    from public.promo_campaign_draft_claims
   where id = p_claim_id
   for update;

  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  if v_claim.status = 'drafted' and v_claim.approval_request_id is not null then
    return query select 'existing'::text, v_claim.approval_request_id;
    return;
  end if;

  if v_claim.status <> 'processing'
     or v_claim.claim_token is distinct from p_claim_token
     or v_claim.lease_expires_at <= v_now then
    return query select 'claim_rejected'::text, null::uuid;
    return;
  end if;

  if char_length(v_title) not between 3 and 120
     or char_length(v_reasoning) not between 10 and 600
     or char_length(v_message) not between 20 and 1000
     or p_language not in ('en', 'vi')
     or jsonb_typeof(p_evidence) is distinct from 'array'
     or jsonb_array_length(p_evidence) > 4 then
    return query select 'invalid_draft'::text, null::uuid;
    return;
  end if;

  -- AI-created messages cannot contain price, percentage, date or time facts.
  -- Owner/admin can add and explicitly confirm those later in a separate RPC.
  if v_message ~ '[0-9%$]'
     or v_message ~* '\m(?:CAD|USD|dollars?|percent|phần[[:space:]]+trăm)\M'
     or v_message ~* '(https?://|www\.|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,})' then
    return query select 'ungrounded_offer_fact'::text, null::uuid;
    return;
  end if;

  insert into public.approval_requests (
    salon_id,
    action_type,
    summary,
    payload,
    urgency,
    expires_at,
    promo_campaign_claim_id
  ) values (
    v_claim.salon_id,
    'bulk_message',
    left(v_title || ': ' || v_message, 1000),
    jsonb_build_object(
      'proposal_source', 'weekly_strategist',
      'proposal_type', 'promo_campaign_draft',
      'title', v_title,
      'message', v_message,
      'reason', v_reasoning,
      'evidence', p_evidence,
      'language', p_language,
      'campaign_mode', 'dashboard_draft_only',
      'notification_mode', 'dashboard_only_no_email',
      'execution_mode', 'owner_review_then_audience_release',
      'delivery_mode', 'no_dispatch',
      'dispatch_enabled', false,
      'promotion_mutation_enabled', false,
      'recipient_selection_required', true,
      'owner_offer_facts_confirmed', false,
      'owner_configuration_required', true,
      'numeric_offer_allowed_from_ai', false,
      'reversible', false
    ),
    'normal',
    v_now + interval '7 days',
    v_claim.id
  )
  returning id into v_approval_id;

  update public.promo_campaign_draft_claims
     set status = 'drafted',
         approval_request_id = v_approval_id,
         updated_at = v_now
   where id = v_claim.id;

  return query select 'created'::text, v_approval_id;
end;
$$;

create or replace function public.fail_promo_campaign_draft(
  p_claim_id uuid,
  p_claim_token uuid,
  p_failure_code text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.promo_campaign_draft_claims
     set status = 'failed',
         failure_code = left(btrim(coalesce(p_failure_code, 'draft_failed')), 80),
         lease_expires_at = statement_timestamp(),
         updated_at = statement_timestamp()
   where id = p_claim_id
     and claim_token = p_claim_token
     and status = 'processing';
  return case when found then 'failed' else 'claim_rejected' end;
end;
$$;

create or replace function public.update_promo_campaign_draft_as_actor(
  p_approval_id uuid,
  p_actor_user_id uuid,
  p_draft_message text,
  p_offer_facts_confirmed boolean default false
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_approval public.approval_requests%rowtype;
  v_message text := btrim(coalesce(p_draft_message, ''));
  v_has_offer_facts boolean;
begin
  select * into v_approval
    from public.approval_requests
   where id = p_approval_id
   for update;

  if not found
     or v_approval.action_type <> 'bulk_message'
     or v_approval.payload ->> 'proposal_source' <> 'weekly_strategist'
     or v_approval.payload ->> 'campaign_mode' <> 'dashboard_draft_only' then
    return 'not_found';
  end if;

  if v_approval.status <> 'pending' then
    return 'already_decided';
  end if;

  if v_approval.expires_at <= v_now then
    return 'expired';
  end if;

  if p_actor_user_id is null or not exists (
    select 1
      from public.salon_members member
     where member.salon_id = v_approval.salon_id
       and member.user_id = p_actor_user_id
       and member.role in ('owner', 'admin')
  ) then
    return 'forbidden';
  end if;

  if char_length(v_message) not between 20 and 1000
     or v_message ~* '(https?://|www\.|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,})' then
    return 'invalid_draft';
  end if;

  v_has_offer_facts :=
    v_message ~ '[0-9%$]'
    or v_message ~* '\m(?:CAD|USD|dollars?|percent|phần[[:space:]]+trăm)\M';

  if v_has_offer_facts and p_offer_facts_confirmed is distinct from true then
    return 'offer_confirmation_required';
  end if;

  update public.approval_requests
     set summary = left(
           coalesce(nullif(v_approval.payload ->> 'title', ''), 'Promo draft')
           || ': ' || v_message,
           1000
         ),
         payload = jsonb_set(
           jsonb_set(
             jsonb_set(
               jsonb_set(
                 v_approval.payload,
                 '{message}',
                 to_jsonb(v_message),
                 true
               ),
               '{owner_offer_facts_confirmed}',
               to_jsonb(v_has_offer_facts and p_offer_facts_confirmed),
               true
             ),
             '{owner_offer_facts_confirmed_by}',
             case
               when v_has_offer_facts and p_offer_facts_confirmed
                 then to_jsonb(p_actor_user_id::text)
               else 'null'::jsonb
             end,
             true
           ),
           '{owner_offer_facts_confirmed_at}',
           case
             when v_has_offer_facts and p_offer_facts_confirmed
               then to_jsonb(v_now::text)
             else 'null'::jsonb
           end,
           true
         )
   where id = v_approval.id;

  return 'updated';
end;
$$;

revoke all on function public.claim_promo_campaign_draft(uuid, text, date)
  from public, anon, authenticated;
revoke all on function public.complete_promo_campaign_draft(
  uuid, uuid, text, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.fail_promo_campaign_draft(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.update_promo_campaign_draft_as_actor(
  uuid, uuid, text, boolean
) from public, anon, authenticated;

grant execute on function public.claim_promo_campaign_draft(uuid, text, date)
  to service_role;
grant execute on function public.complete_promo_campaign_draft(
  uuid, uuid, text, text, text, text, jsonb
) to service_role;
grant execute on function public.fail_promo_campaign_draft(uuid, uuid, text)
  to service_role;
grant execute on function public.update_promo_campaign_draft_as_actor(
  uuid, uuid, text, boolean
) to service_role;

-- Add the opt-in strategist draft flag to the existing atomic permission gate.
alter table public.ai_agent_permission_audit
  drop constraint ai_agent_permission_audit_flag_key_check;
alter table public.ai_agent_permission_audit
  add constraint ai_agent_permission_audit_flag_key_check check (
    flag_key in (
      'ai_noshow_policy_live', 'ai_watchdog', 'ai_winback', 'ai_rebook',
      'ai_smart_reminders', 'ai_social_content', 'ai_vip_care',
      'ai_first_visit_nurture', 'ai_unified_digest', 'ai_gbp_post',
      'ai_yelp_reply', 'ai_promo_campaign_drafts'
    )
  );

create or replace function public.set_ai_agent_permission(
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_actor_kind text,
  p_flag_key text,
  p_enabled boolean,
  p_impact text,
  p_impact_acknowledged boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expected_impact text;
  v_flags jsonb;
  v_ai_profile jsonb;
  v_previous boolean;
  v_had_any_agent boolean;
  v_changed boolean;
  v_agent_keys constant text[] := array[
    'ai_noshow_policy_live', 'ai_watchdog', 'ai_winback', 'ai_rebook',
    'ai_smart_reminders', 'ai_social_content', 'ai_vip_care',
    'ai_first_visit_nurture', 'ai_unified_digest', 'ai_gbp_post',
    'ai_yelp_reply', 'ai_promo_campaign_drafts'
  ];
begin
  if p_salon_id is null or p_enabled is null then
    return jsonb_build_object('success', false, 'code', 'invalid_input');
  end if;

  v_expected_impact := case p_flag_key
    when 'ai_noshow_policy_live' then 'booking_policy'
    when 'ai_watchdog' then 'monitoring'
    when 'ai_winback' then 'customer_outreach'
    when 'ai_rebook' then 'customer_outreach'
    when 'ai_smart_reminders' then 'customer_outreach'
    when 'ai_social_content' then 'draft_only'
    when 'ai_vip_care' then 'customer_outreach'
    when 'ai_first_visit_nurture' then 'customer_outreach'
    when 'ai_unified_digest' then 'owner_notification'
    when 'ai_gbp_post' then 'draft_only'
    when 'ai_yelp_reply' then 'draft_only'
    when 'ai_promo_campaign_drafts' then 'draft_only'
    else null
  end;

  if v_expected_impact is null or p_impact is distinct from v_expected_impact then
    return jsonb_build_object('success', false, 'code', 'invalid_agent_impact');
  end if;

  if p_actor_role not in ('owner', 'admin')
     or p_actor_kind not in ('member', 'demo_cookie') then
    return jsonb_build_object('success', false, 'code', 'forbidden');
  end if;

  if p_actor_kind = 'member' then
    if p_actor_user_id is null or not exists (
      select 1
      from public.salon_members sm
      where sm.salon_id = p_salon_id
        and sm.user_id = p_actor_user_id
        and sm.role = p_actor_role
        and sm.role in ('owner', 'admin')
    ) then
      return jsonb_build_object('success', false, 'code', 'forbidden');
    end if;
  elsif p_actor_user_id is not null then
    return jsonb_build_object('success', false, 'code', 'invalid_actor');
  end if;

  if p_enabled
     and v_expected_impact in ('booking_policy', 'customer_outreach')
     and p_impact_acknowledged is distinct from true then
    return jsonb_build_object(
      'success', false, 'code', 'impact_confirmation_required'
    );
  end if;

  select coalesce(s.feature_flags, '{}'::jsonb), s.ai_profile
    into v_flags, v_ai_profile
  from public.salons s
  where s.id = p_salon_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'code', 'salon_not_found');
  end if;

  v_previous := coalesce(v_flags -> p_flag_key = 'true'::jsonb, false);
  v_had_any_agent := exists (
    select 1
    from unnest(v_agent_keys) as agent_key
    where v_flags -> agent_key = 'true'::jsonb
  );
  v_changed := v_previous is distinct from p_enabled;

  if v_changed then
    perform set_config(
      'app.actor_user_id',
      coalesce(p_actor_user_id::text, ''),
      true
    );

    update public.salons
    set feature_flags = jsonb_set(
      v_flags,
      array[p_flag_key],
      to_jsonb(p_enabled),
      true
    )
    where id = p_salon_id;

    insert into public.ai_agent_permission_audit (
      salon_id, actor_user_id, actor_role, actor_kind, flag_key, impact,
      enabled, previous_enabled, impact_acknowledged
    ) values (
      p_salon_id, p_actor_user_id, p_actor_role, p_actor_kind, p_flag_key,
      v_expected_impact, p_enabled, v_previous,
      coalesce(p_impact_acknowledged, false)
    );
  end if;

  return jsonb_build_object(
    'success', true,
    'changed', v_changed,
    'previous_enabled', v_previous,
    'had_any_agent', v_had_any_agent,
    'has_ai_profile', v_ai_profile is not null
  );
end;
$$;

revoke execute on function public.set_ai_agent_permission(
  uuid, uuid, text, text, text, boolean, text, boolean
) from public, anon, authenticated;
grant execute on function public.set_ai_agent_permission(
  uuid, uuid, text, text, text, boolean, text, boolean
) to service_role;

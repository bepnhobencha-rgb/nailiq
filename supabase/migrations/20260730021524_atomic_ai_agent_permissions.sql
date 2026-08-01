-- AI agent permission changes are control-plane writes. Keep the flag update,
-- actor attribution, and an explicit permission audit in one transaction so
-- concurrent toggles cannot overwrite each other and a successful response
-- always has durable evidence.

create table public.ai_agent_permission_audit (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_role text not null check (actor_role in ('owner', 'admin')),
  actor_kind text not null check (actor_kind in ('member', 'demo_cookie')),
  flag_key text not null check (
    flag_key in (
      'ai_noshow_policy_live',
      'ai_watchdog',
      'ai_winback',
      'ai_rebook',
      'ai_smart_reminders',
      'ai_social_content',
      'ai_vip_care',
      'ai_first_visit_nurture',
      'ai_unified_digest',
      'ai_gbp_post',
      'ai_yelp_reply'
    )
  ),
  impact text not null check (
    impact in (
      'booking_policy',
      'customer_outreach',
      'owner_notification',
      'draft_only',
      'monitoring'
    )
  ),
  enabled boolean not null,
  previous_enabled boolean not null,
  impact_acknowledged boolean not null,
  created_at timestamptz not null default now()
);

comment on table public.ai_agent_permission_audit is
  'Append-only evidence for owner/admin grants and revocations of AI operating permissions.';

create index ai_agent_permission_audit_salon_created_idx
  on public.ai_agent_permission_audit (salon_id, created_at desc);

alter table public.ai_agent_permission_audit enable row level security;
revoke all on table public.ai_agent_permission_audit
  from public, anon, authenticated;
grant all on table public.ai_agent_permission_audit to service_role;

create or replace function public.reject_ai_agent_permission_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Preserve intentional salon deletion. Direct changes to permission history
  -- remain forbidden even to service-role callers.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;

  raise exception 'ai_agent_permission_audit_is_immutable'
    using errcode = '55000';
end;
$$;

create trigger ai_agent_permission_audit_immutable
  before update or delete on public.ai_agent_permission_audit
  for each row
  execute function public.reject_ai_agent_permission_audit_mutation();

revoke all on function public.reject_ai_agent_permission_audit_mutation()
  from public, anon, authenticated;

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
    'ai_noshow_policy_live',
    'ai_watchdog',
    'ai_winback',
    'ai_rebook',
    'ai_smart_reminders',
    'ai_social_content',
    'ai_vip_care',
    'ai_first_visit_nurture',
    'ai_unified_digest',
    'ai_gbp_post',
    'ai_yelp_reply'
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
    -- The existing salons trigger can now attribute its generic field audit to
    -- the same actor inside this transaction.
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
      salon_id,
      actor_user_id,
      actor_role,
      actor_kind,
      flag_key,
      impact,
      enabled,
      previous_enabled,
      impact_acknowledged
    )
    values (
      p_salon_id,
      p_actor_user_id,
      p_actor_role,
      p_actor_kind,
      p_flag_key,
      v_expected_impact,
      p_enabled,
      v_previous,
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

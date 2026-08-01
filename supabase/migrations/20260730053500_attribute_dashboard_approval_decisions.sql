-- Attribute dashboard approval decisions to the authenticated owner/admin while
-- keeping email links as anonymous capability decisions. The existing token
-- function remains the email boundary; this wrapper resolves the token inside
-- the database so dashboard clients never receive approval bearer secrets.

alter table public.approval_requests
  add column if not exists decision_channel text;

alter table public.approval_requests
  drop constraint if exists approval_requests_decision_channel_check;

alter table public.approval_requests
  add constraint approval_requests_decision_channel_check
  check (
    decision_channel is null
    or decision_channel in ('dashboard', 'email_capability')
  );

create or replace function public.mark_ai_approval_decision_channel()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'pending'
     and new.status in ('approved', 'declined')
     and new.decision_channel is null then
    new.decision_channel := 'email_capability';
  end if;
  return new;
end;
$$;

drop trigger if exists mark_ai_approval_decision_channel
  on public.approval_requests;
create trigger mark_ai_approval_decision_channel
before update on public.approval_requests
for each row execute function public.mark_ai_approval_decision_channel();

create or replace function public.decide_ai_approval_request_as_actor(
  p_approval_id uuid,
  p_decision text,
  p_actor_user_id uuid
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
  v_token text;
  v_transition record;
begin
  if p_decision not in ('approved', 'declined') or p_actor_user_id is null then
    return query
      select 'invalid_decision'::text, null::uuid, null::uuid, null::text,
             null::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  select ar.*
    into v_request
    from public.approval_requests ar
   where ar.id = p_approval_id
   for update;

  if not found then
    return query
      select 'not_found'::text, null::uuid, null::uuid, null::text,
             null::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  if not exists (
    select 1
      from public.salon_members sm
     where sm.salon_id = v_request.salon_id
       and sm.user_id = p_actor_user_id
       and sm.role in ('owner', 'admin')
  ) then
    return query
      select 'forbidden'::text, v_request.id, v_request.salon_id,
             v_request.action_type, v_request.status, null::uuid, null::text,
             v_request.decided_at;
    return;
  end if;

  v_token := case
    when p_decision = 'approved' then v_request.approve_token
    else v_request.decline_token
  end;

  select *
    into v_transition
    from public.decide_ai_approval_request(v_token, p_decision);

  if v_transition.outcome in ('approved_queued', 'declined') then
    update public.approval_requests
       set decided_by = p_actor_user_id,
           decision_channel = 'dashboard'
     where id = p_approval_id;

    insert into public.ai_actions_log (
      salon_id, agent, action_type, target_id, payload
    ) values (
      v_request.salon_id,
      'ai_approval',
      'approval_actor_attributed',
      p_approval_id,
      jsonb_build_object(
        'actor_user_id', p_actor_user_id,
        'decision_channel', 'dashboard',
        'approval_decision', p_decision
      )
    );
  end if;

  return query
    select v_transition.outcome::text,
           v_transition.approval_id::uuid,
           v_transition.salon_id::uuid,
           v_transition.action_type::text,
           v_transition.decision_status::text,
           v_transition.execution_job_id::uuid,
           v_transition.execution_status::text,
           v_transition.decided_at::timestamptz;
end;
$$;

revoke all on function public.decide_ai_approval_request_as_actor(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.decide_ai_approval_request_as_actor(uuid, text, uuid)
  to service_role;

comment on column public.approval_requests.decision_channel is
  'Origin of a completed decision. Dashboard decisions have an authenticated decided_by; email capability decisions remain unattributed.';
comment on function public.decide_ai_approval_request_as_actor(uuid, text, uuid) is
  'Atomically validates owner/admin membership, decides an approval, and attributes the dashboard actor without exposing bearer tokens.';
comment on function public.mark_ai_approval_decision_channel() is
  'Labels token-based approval decisions as email capabilities unless an authenticated dashboard wrapper replaces the channel in the same transaction.';

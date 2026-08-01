-- A daily digest is only complete after the provider accepted it and NailIQ
-- durably recorded that outcome. The provider call uses a stable idempotency
-- key; this transaction makes the database acknowledgement replay-safe.

create table public.ai_digest_deliveries (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  digest_date date not null,
  provider_message_id text,
  sent_at timestamptz not null,
  approval_ids uuid[] not null default '{}',
  agents_active text[] not null default '{}',
  recipient_count integer not null
    check (recipient_count > 0 and recipient_count <= 100),
  created_at timestamptz not null default now(),
  unique (salon_id, digest_date)
);

create index ai_digest_deliveries_salon_sent_idx
  on public.ai_digest_deliveries (salon_id, sent_at desc);

alter table public.ai_digest_deliveries enable row level security;

revoke all on table public.ai_digest_deliveries
  from public, anon, authenticated;
grant select, insert on table public.ai_digest_deliveries
  to service_role;

comment on table public.ai_digest_deliveries is
  'Provider-acknowledged daily digest deliveries. One replay-safe row per salon day.';
comment on column public.ai_digest_deliveries.approval_ids is
  'Normal-urgency approvals actually included in this delivered digest.';

create or replace function public.record_ai_digest_delivery(
  p_salon_id uuid,
  p_digest_date date,
  p_provider_message_id text,
  p_sent_at timestamptz,
  p_approval_ids uuid[] default '{}',
  p_agents_active text[] default '{}',
  p_recipient_count integer default 1
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivery_id uuid;
  v_expected_approvals integer;
  v_matching_approvals integer;
begin
  if p_salon_id is null
     or p_digest_date is null
     or p_sent_at is null
     or p_recipient_count < 1
     or p_recipient_count > 100 then
    raise exception 'invalid_digest_delivery';
  end if;

  if p_digest_date <> (p_sent_at at time zone 'UTC')::date
     and abs(p_digest_date - (p_sent_at at time zone 'UTC')::date) > 2 then
    raise exception 'invalid_digest_delivery_date';
  end if;

  select count(distinct approval_id)
    into v_expected_approvals
  from unnest(coalesce(p_approval_ids, '{}'::uuid[])) as approval_id;

  select count(*)
    into v_matching_approvals
  from public.approval_requests ar
  where ar.id = any(coalesce(p_approval_ids, '{}'::uuid[]))
    and ar.salon_id = p_salon_id
    and ar.urgency = 'normal';

  if v_matching_approvals <> v_expected_approvals then
    raise exception 'digest_approval_scope_mismatch';
  end if;

  insert into public.ai_digest_deliveries (
    salon_id,
    digest_date,
    provider_message_id,
    sent_at,
    approval_ids,
    agents_active,
    recipient_count
  )
  values (
    p_salon_id,
    p_digest_date,
    nullif(left(coalesce(p_provider_message_id, ''), 255), ''),
    p_sent_at,
    coalesce(p_approval_ids, '{}'::uuid[]),
    coalesce(p_agents_active, '{}'::text[]),
    p_recipient_count
  )
  on conflict (salon_id, digest_date) do update
    set provider_message_id = coalesce(
          public.ai_digest_deliveries.provider_message_id,
          excluded.provider_message_id
        )
  returning id into v_delivery_id;

  update public.approval_requests ar
  set notified_at = coalesce(ar.notified_at, p_sent_at)
  where ar.id = any(coalesce(p_approval_ids, '{}'::uuid[]))
    and ar.salon_id = p_salon_id
    and ar.urgency = 'normal';

  insert into public.ai_actions_log (
    salon_id,
    agent,
    action_type,
    target_id,
    payload,
    undo_deadline
  )
  select
    p_salon_id,
    'digest',
    'digest_sent',
    v_delivery_id,
    jsonb_build_object(
      'today', p_digest_date::text,
      'agents_active', to_jsonb(coalesce(p_agents_active, '{}'::text[])),
      'approval_count', v_expected_approvals,
      'recipient_count', p_recipient_count
    ),
    null
  where not exists (
    select 1
    from public.ai_actions_log a
    where a.agent = 'digest'
      and a.action_type = 'digest_sent'
      and a.target_id = v_delivery_id
  );

  return v_delivery_id;
end;
$$;

revoke all on function public.record_ai_digest_delivery(
  uuid, date, text, timestamptz, uuid[], text[], integer
) from public, anon, authenticated;
grant execute on function public.record_ai_digest_delivery(
  uuid, date, text, timestamptz, uuid[], text[], integer
) to service_role;


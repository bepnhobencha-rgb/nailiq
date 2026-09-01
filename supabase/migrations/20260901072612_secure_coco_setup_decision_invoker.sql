-- QA received the first Coco decision RPC before the final service-only
-- boundary was selected. Remove that overload, then converge every database
-- on the RLS-preserving, service-role-invoked signature used by the server
-- action. No salon is enabled and no decision row is written here.

drop function if exists public.save_coco_setup_decision(uuid, text, text);

create or replace function public.save_coco_setup_decision(
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_capability text,
  p_decision text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $save_coco_setup_decision$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_flags jsonb;
  v_decisions jsonb;
begin
  if v_request_role <> 'service_role' or p_actor_user_id is null then
    return pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;

  if p_capability not in (
    'resource_capacity',
    'multi_service',
    'group_booking',
    'waitlist_walkin',
    'customer_identity_otp',
    'payments_checkout',
    'ai_automation',
    'reporting_alerts'
  ) or p_decision not in ('configured_off', 'not_using') then
    return pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_decision');
  end if;

  if not exists (
    select 1
    from public.salon_members as sm
    where sm.salon_id = p_salon_id
      and sm.user_id = p_actor_user_id
      and sm.role in ('owner', 'admin')
  ) then
    return pg_catalog.jsonb_build_object('success', false, 'code', 'forbidden');
  end if;

  select coalesce(s.feature_flags, '{}'::jsonb)
  into v_flags
  from public.salons as s
  where s.id = p_salon_id
    and s.archived_at is null
    and s.feature_flags ->> 'coco_setup_activation_version' = '1'
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('success', false, 'code', 'not_active');
  end if;

  v_decisions := case
    when pg_catalog.jsonb_typeof(v_flags -> 'coco_setup_decisions') = 'object'
      then v_flags -> 'coco_setup_decisions'
    else '{}'::jsonb
  end;

  update public.salons as s
  set feature_flags = pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_flags,
      '{coco_setup_decisions}',
      v_decisions,
      true
    ),
    array['coco_setup_decisions', p_capability],
    pg_catalog.to_jsonb(p_decision),
    true
  )
  where s.id = p_salon_id;

  return pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'saved',
    'capability', p_capability,
    'decision', p_decision
  );
end;
$save_coco_setup_decision$;

comment on function public.save_coco_setup_decision(uuid, uuid, text, text) is
  'Service-role-only atomic recorder for a bounded Owner/Admin use-or-skip decision on an activated Coco Setup salon.';

revoke all on function public.save_coco_setup_decision(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.save_coco_setup_decision(uuid, uuid, text, text)
  to service_role;

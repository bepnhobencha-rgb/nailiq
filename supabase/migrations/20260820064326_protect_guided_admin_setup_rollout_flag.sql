-- Guided Admin Setup is a controlled QA rollout. The registry reads only
-- `feature_flags.guided_admin_setup_enabled`, but the broad owner/admin salon
-- UPDATE policy currently lets a salon member turn that key on through a
-- direct PostgREST PATCH. Preserve every sibling flag while reserving changes
-- to this one key for the service-role Superadmin path or an active platform
-- SuperAdmin who also satisfies the normal salon-row RLS policy.
create or replace function public.protect_guided_admin_setup_rollout_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_caller_user_id uuid := (select auth.uid());
  v_old_value jsonb;
  v_new_value jsonb;
begin
  if tg_op = 'INSERT' then
    v_old_value := null;
  else
    v_old_value := old.feature_flags -> 'guided_admin_setup_enabled';
  end if;
  v_new_value := new.feature_flags -> 'guided_admin_setup_enabled';

  if v_old_value is not distinct from v_new_value then
    return new;
  end if;

  -- New salons remain default-off. Explicit false/null is also safe at insert;
  -- every later change, including removal of an existing override, is gated.
  if tg_op = 'INSERT'
     and coalesce(v_new_value, 'false'::jsonb) <> 'true'::jsonb then
    return new;
  end if;

  if v_request_role = 'service_role'
     or (
       v_request_role = ''
       and session_user in ('postgres', 'supabase_admin')
     )
     or (
       v_request_role = 'authenticated'
       and v_caller_user_id is not null
       and exists (
         select 1
         from public.superadmins as sa
         where sa.user_id = v_caller_user_id
           and sa.revoked_at is null
       )
     ) then
    return new;
  end if;

  raise exception 'guided admin setup rollout flag requires SuperAdmin authorization'
    using errcode = '42501';
end;
$$;

comment on function public.protect_guided_admin_setup_rollout_flag() is
  'Keeps guided_admin_setup_enabled default-off and blocks salon-member rollout changes while preserving sibling feature flags.';

revoke all on function public.protect_guided_admin_setup_rollout_flag()
  from public, anon, authenticated;

drop trigger if exists protect_guided_admin_setup_rollout_flag_trigger
  on public.salons;
create trigger protect_guided_admin_setup_rollout_flag_trigger
  before insert or update of feature_flags
  on public.salons
  for each row
  execute function public.protect_guided_admin_setup_rollout_flag();

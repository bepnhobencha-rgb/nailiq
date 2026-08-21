\set ON_ERROR_STOP on

-- Rehearse the exact emergency rollback. The legacy owner/admin UPDATE policy
-- is intentionally left intact; removing only this trigger restores the former
-- ability to self-enable Guided Setup. The outer rollback then restores the
-- hardened boundary on the throwaway database.
begin;

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  '17000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'guided-rollback-owner@nailiq.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}',
  '{}',
  now(),
  now()
);

insert into public.salons (id, slug, name, phone)
values (
  '27000000-0000-0000-0000-000000000001',
  'guided-rollout-rollback-test',
  'Guided Rollout Rollback Test',
  '+16045550611'
);

insert into public.salon_members (salon_id, user_id, role)
values (
  '27000000-0000-0000-0000-000000000001',
  '17000000-0000-0000-0000-000000000001',
  'owner'
);

drop trigger if exists protect_guided_admin_setup_rollout_flag_trigger
  on public.salons;
drop function if exists public.protect_guided_admin_setup_rollout_flag();

do $rollback_shape$
begin
  if to_regprocedure(
    'public.protect_guided_admin_setup_rollout_flag()'
  ) is not null then
    raise exception 'rollback left the rollout trigger function installed';
  end if;

  if exists (
    select 1
    from pg_trigger as t
    join pg_class as c on c.oid = t.tgrelid
    join pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'salons'
      and t.tgname = 'protect_guided_admin_setup_rollout_flag_trigger'
      and not t.tgisinternal
  ) then
    raise exception 'rollback left the rollout trigger installed';
  end if;
end
$rollback_shape$;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  '17000000-0000-0000-0000-000000000001',
  true
);

update public.salons
set feature_flags = jsonb_set(
  feature_flags,
  '{guided_admin_setup_enabled}',
  'true'::jsonb,
  true
)
where id = '27000000-0000-0000-0000-000000000001';

do $legacy_behavior$
begin
  if (
    select count(*)
    from public.salons
    where id = '27000000-0000-0000-0000-000000000001'
      and feature_flags -> 'guided_admin_setup_enabled' = 'true'::jsonb
  ) <> 1 then
    raise exception 'rollback did not restore the legacy owner write';
  end if;
end
$legacy_behavior$;

reset role;
rollback;

-- The rehearsal itself is non-persistent: verify the trigger/function returned.
begin;
do $hardened_state_restored$
begin
  if to_regprocedure(
    'public.protect_guided_admin_setup_rollout_flag()'
  ) is null then
    raise exception 'rollback rehearsal did not restore the hardened function';
  end if;

  if not exists (
    select 1
    from pg_trigger as t
    join pg_class as c on c.oid = t.tgrelid
    join pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'salons'
      and t.tgname = 'protect_guided_admin_setup_rollout_flag_trigger'
      and not t.tgisinternal
  ) then
    raise exception 'rollback rehearsal did not restore the hardened trigger';
  end if;
end
$hardened_state_restored$;
rollback;

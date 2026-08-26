\set ON_ERROR_STOP on

-- Rehearse the safe operational rollback for the disposable-QA rollout.
-- This does not remove the trigger/RPC security boundary. It proves the exact
-- disable command atomically removes the tenant flag and singleton allowlist;
-- the outer transaction makes the rehearsal itself non-persistent.
begin;

insert into public.salons (
  id,
  slug,
  name,
  phone,
  is_beta,
  subscription_status
)
values (
  '29000000-0000-4000-8000-000000000001',
  'guided-qa-rollback-rehearsal',
  'Guided QA Rollback Rehearsal',
  '+16045550711',
  true,
  'trialing'
);

insert into public.platform_flags (key, enabled)
values ('feature_guided_admin_setup', true)
on conflict (key) do update
set enabled = excluded.enabled;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

do $enable_then_disable$
declare
  v_result jsonb;
begin
  select public.configure_guided_admin_setup_qa_salon(
    '29000000-0000-4000-8000-000000000001',
    true,
    'ENABLE_GUIDED_ADMIN_SETUP_QA'
  ) into v_result;
  if v_result->>'code' <> 'enabled' then
    raise exception 'rollback rehearsal could not establish enabled state: %',
      v_result;
  end if;

  select public.configure_guided_admin_setup_qa_salon(
    '29000000-0000-4000-8000-000000000001',
    false,
    'DISABLE_GUIDED_ADMIN_SETUP_QA'
  ) into v_result;
  if v_result->>'code' <> 'disabled' then
    raise exception 'safe rollout rollback did not return disabled: %', v_result;
  end if;

  if exists (
    select 1
    from public.platform_settings
    where id = 'platform'
      and guided_admin_setup_qa_salon_id is not null
  ) then
    raise exception 'safe rollout rollback left the singleton allowlist set';
  end if;
  if exists (
    select 1
    from public.salons
    where id = '29000000-0000-4000-8000-000000000001'
      and feature_flags ? 'guided_admin_setup_enabled'
  ) then
    raise exception 'safe rollout rollback left the tenant flag set';
  end if;
end
$enable_then_disable$;

reset role;
rollback;

begin;
do $hardened_state_restored$
begin
  if to_regprocedure(
    'public.configure_guided_admin_setup_qa_salon(uuid,boolean,text)'
  ) is null then
    raise exception 'rollback rehearsal did not restore the dedicated setter';
  end if;
  if to_regprocedure(
    'public.protect_guided_admin_setup_rollout_flag()'
  ) is null then
    raise exception 'rollback rehearsal did not restore the hardened trigger function';
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
  if exists (
    select 1
    from public.salons
    where id = '29000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'rollback rehearsal leaked its disposable salon fixture';
  end if;
end
$hardened_state_restored$;
rollback;

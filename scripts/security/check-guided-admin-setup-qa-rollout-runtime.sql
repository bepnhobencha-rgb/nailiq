\set ON_ERROR_STOP on

-- Fresh/local Postgres proof only. All fixtures and mutations roll back.
begin;

insert into public.salons (
  id, slug, name, phone, is_beta, subscription_status, archived_at
)
values
  ('28000000-0000-4000-8000-000000000001', 'guided-qa-one', 'Guided QA One', '+16045550701', true, 'trialing', null),
  ('28000000-0000-4000-8000-000000000002', 'guided-qa-two', 'Guided QA Two', '+16045550702', true, 'active', null),
  ('28000000-0000-4000-8000-000000000003', 'guided-non-beta', 'Guided Non Beta', '+16045550703', false, 'trialing', null),
  ('28000000-0000-4000-8000-000000000004', 'guided-archived', 'Guided Archived', '+16045550704', true, 'trialing', now()),
  ('28000000-0000-4000-8000-000000000005', 'guided-inactive', 'Guided Inactive', '+16045550705', true, 'past_due', null),
  ('28000000-0000-4000-8000-000000000006', 'guided-safe-name-a', 'Hi-Lite Head Spa', '+16045550706', true, 'active', null),
  ('28000000-0000-4000-8000-000000000007', 'guided-safe-name-b', 'Hi-Lite Studio', '+16045550707', true, 'active', null),
  ('28000000-0000-4000-8000-000000000008', 'hilite-anaheim', 'Guided Safe Slug A', '+16045550708', true, 'active', null),
  ('28000000-0000-4000-8000-000000000009', 'hilite-studio', 'Guided Safe Slug B', '+16045550709', true, 'active', null);

do $acl_proof$
begin
  if has_function_privilege(
    'anon',
    'public.configure_guided_admin_setup_qa_salon(uuid,boolean,text)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.configure_guided_admin_setup_qa_salon(uuid,boolean,text)',
    'execute'
  ) or has_function_privilege(
    'public',
    'public.configure_guided_admin_setup_qa_salon(uuid,boolean,text)',
    'execute'
  ) then
    raise exception 'dedicated QA setter leaked execute outside service_role';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.configure_guided_admin_setup_qa_salon(uuid,boolean,text)',
    'execute'
  ) then
    raise exception 'service_role cannot execute the dedicated QA setter';
  end if;
end
$acl_proof$;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

do $platform_and_confirmation_proof$
declare
  v_result jsonb;
begin
  select public.configure_guided_admin_setup_qa_salon(
    '28000000-0000-4000-8000-000000000001',
    true,
    'ENABLE_GUIDED_ADMIN_SETUP_QA'
  ) into v_result;
  if v_result->>'code' <> 'platform_disabled' then
    raise exception 'platform OFF did not fail closed: %', v_result;
  end if;

  select public.configure_guided_admin_setup_qa_salon(
    '28000000-0000-4000-8000-000000000001',
    true,
    'enable_guided_admin_setup_qa'
  ) into v_result;
  if v_result->>'code' <> 'confirmation_required' then
    raise exception 'inexact confirmation was accepted: %', v_result;
  end if;
end
$platform_and_confirmation_proof$;

reset role;
insert into public.platform_flags (key, enabled)
values ('feature_guided_admin_setup', true)
on conflict (key) do update
set enabled = excluded.enabled;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

do $disposable_identity_proof$
declare
  v_id uuid;
  v_result jsonb;
begin
  foreach v_id in array array[
    '28000000-0000-4000-8000-000000000003'::uuid,
    '28000000-0000-4000-8000-000000000004'::uuid,
    '28000000-0000-4000-8000-000000000005'::uuid,
    '28000000-0000-4000-8000-000000000006'::uuid,
    '28000000-0000-4000-8000-000000000007'::uuid,
    '28000000-0000-4000-8000-000000000008'::uuid,
    '28000000-0000-4000-8000-000000000009'::uuid
  ] loop
    select public.configure_guided_admin_setup_qa_salon(
      v_id,
      true,
      'ENABLE_GUIDED_ADMIN_SETUP_QA'
    ) into v_result;
    if v_result->>'code' <> 'salon_not_disposable_qa' then
      raise exception 'non-disposable or Hi-Lite identity was accepted: %, %',
        v_id, v_result;
    end if;
  end loop;
end
$disposable_identity_proof$;

do $single_allowlist_proof$
declare
  v_result jsonb;
begin
  select public.configure_guided_admin_setup_qa_salon(
    '28000000-0000-4000-8000-000000000001',
    true,
    'ENABLE_GUIDED_ADMIN_SETUP_QA'
  ) into v_result;
  if v_result->>'code' <> 'enabled' then
    raise exception 'valid disposable QA salon did not enable: %', v_result;
  end if;

  select public.configure_guided_admin_setup_qa_salon(
    '28000000-0000-4000-8000-000000000002',
    true,
    'ENABLE_GUIDED_ADMIN_SETUP_QA'
  ) into v_result;
  if v_result->>'code' <> 'allowlist_conflict' then
    raise exception 'second tenant escaped the singleton allowlist: %', v_result;
  end if;

  begin
    update public.salons
    set feature_flags = jsonb_set(
      feature_flags,
      '{guided_admin_setup_enabled}',
      'true'::jsonb,
      true
    )
    where id = '28000000-0000-4000-8000-000000000002';
    raise exception 'generic service-role update escaped the exact allowlist';
  exception
    when insufficient_privilege then null;
  end;
end
$single_allowlist_proof$;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
do $generic_authenticated_unset_proof$
begin
  begin
    update public.salons
    set feature_flags = feature_flags - 'guided_admin_setup_enabled'
    where id = '28000000-0000-4000-8000-000000000001';
    raise exception 'generic authenticated unset escaped the protected boundary';
  exception
    when insufficient_privilege then null;
  end;
end
$generic_authenticated_unset_proof$;

reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
do $disable_proof$
declare
  v_result jsonb;
begin
  select public.configure_guided_admin_setup_qa_salon(
    '28000000-0000-4000-8000-000000000001',
    false,
    'DISABLE_GUIDED_ADMIN_SETUP_QA'
  ) into v_result;
  if v_result->>'code' <> 'disabled' then
    raise exception 'dedicated disable failed: %', v_result;
  end if;
  if exists (
    select 1 from public.platform_settings
    where id = 'platform'
      and guided_admin_setup_qa_salon_id is not null
  ) or exists (
    select 1 from public.salons
    where id = '28000000-0000-4000-8000-000000000001'
      and feature_flags ? 'guided_admin_setup_enabled'
  ) then
    raise exception 'disable did not atomically clear allowlist and tenant flag';
  end if;
end
$disable_proof$;

reset role;
select 'PASS: guided admin setup disposable-QA rollout runtime proof' as result;
rollback;

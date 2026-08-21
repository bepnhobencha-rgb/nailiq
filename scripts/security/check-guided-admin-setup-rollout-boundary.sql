\set ON_ERROR_STOP on

-- Direct Postgres-role rehearsal of the Data API boundary. Every fixture and
-- the temporary INSERT policy live only inside this transaction.
begin;

do $schema_proof$
begin
  if not exists (
    select 1
    from pg_proc as p
    join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'protect_guided_admin_setup_rollout_flag'
      and p.prosecdef
      and p.proconfig @> array['search_path=""']::text[]
  ) then
    raise exception 'guided setup rollout trigger function is not hardened';
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
    raise exception 'guided setup rollout trigger is missing';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.protect_guided_admin_setup_rollout_flag()',
    'EXECUTE'
  ) then
    raise exception 'authenticated can invoke the rollout trigger function directly';
  end if;
end
$schema_proof$;

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
values
  (
    '16000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'guided-owner@nailiq.invalid',
    '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()
  ),
  (
    '16000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'guided-admin@nailiq.invalid',
    '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()
  ),
  (
    '16000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'guided-senior@nailiq.invalid',
    '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()
  ),
  (
    '16000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'guided-receptionist@nailiq.invalid',
    '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()
  ),
  (
    '16000000-0000-0000-0000-000000000005',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'guided-nail-tech@nailiq.invalid',
    '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()
  ),
  (
    '16000000-0000-0000-0000-000000000006',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'guided-superadmin@nailiq.invalid',
    '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()
  ),
  (
    '16000000-0000-0000-0000-000000000007',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'guided-cross-tenant-owner@nailiq.invalid',
    '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()
  ),
  (
    '16000000-0000-0000-0000-000000000008',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'guided-revoked-superadmin@nailiq.invalid',
    '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()
  );

insert into public.salons (id, slug, name, phone)
values
  (
    '26000000-0000-0000-0000-000000000001',
    'guided-rollout-boundary-test',
    'Guided Rollout Boundary Test',
    '+16045550601'
  ),
  (
    '26000000-0000-0000-0000-000000000002',
    'guided-rollout-cross-tenant-test',
    'Guided Rollout Cross Tenant Test',
    '+16045550602'
  );

insert into public.salon_members (salon_id, user_id, role)
values
  ('26000000-0000-0000-0000-000000000001', '16000000-0000-0000-0000-000000000001', 'owner'),
  ('26000000-0000-0000-0000-000000000001', '16000000-0000-0000-0000-000000000002', 'admin'),
  ('26000000-0000-0000-0000-000000000001', '16000000-0000-0000-0000-000000000003', 'senior'),
  ('26000000-0000-0000-0000-000000000001', '16000000-0000-0000-0000-000000000004', 'receptionist'),
  ('26000000-0000-0000-0000-000000000001', '16000000-0000-0000-0000-000000000005', 'nail_tech'),
  ('26000000-0000-0000-0000-000000000001', '16000000-0000-0000-0000-000000000006', 'owner'),
  ('26000000-0000-0000-0000-000000000001', '16000000-0000-0000-0000-000000000008', 'owner'),
  ('26000000-0000-0000-0000-000000000002', '16000000-0000-0000-0000-000000000007', 'owner');

insert into public.superadmins (user_id, role, revoked_at)
values
  ('16000000-0000-0000-0000-000000000006', 'ops_admin', null),
  (
    '16000000-0000-0000-0000-000000000008',
    'ops_admin',
    now()
  );

-- The production schema intentionally has no authenticated salon INSERT
-- policy. This transaction-only policy isolates and exercises the trigger's
-- future-safe INSERT semantics without weakening the shipped schema.
create policy guided_admin_setup_insert_rehearsal_only
  on public.salons
  for insert
  to authenticated
  with check (true);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);

-- Owner may still update an unrelated sibling flag.
select set_config(
  'request.jwt.claim.sub',
  '16000000-0000-0000-0000-000000000001',
  true
);
update public.salons
set feature_flags = jsonb_set(
  feature_flags,
  '{group_booking_enabled}',
  'true'::jsonb,
  true
)
where id = '26000000-0000-0000-0000-000000000001';

do $owner_denied$
begin
  begin
    update public.salons
    set feature_flags = jsonb_set(
      feature_flags,
      '{guided_admin_setup_enabled}',
      'true'::jsonb,
      true
    )
    where id = '26000000-0000-0000-0000-000000000001';
    raise exception 'owner unexpectedly enabled Guided Admin Setup';
  exception
    when insufficient_privilege then null;
  end;
end
$owner_denied$;

-- Default/explicit-false INSERT values stay safe and usable, but an
-- authenticated caller cannot seed the rollout ON.
insert into public.salons (id, slug, name, phone)
values (
  '26000000-0000-0000-0000-000000000003',
  'guided-rollout-safe-default-insert',
  'Guided Rollout Safe Default Insert',
  '+16045550603'
);

insert into public.salons (id, slug, name, phone, feature_flags)
values (
  '26000000-0000-0000-0000-000000000004',
  'guided-rollout-safe-false-insert',
  'Guided Rollout Safe False Insert',
  '+16045550604',
  '{"guided_admin_setup_enabled": false}'::jsonb
);

do $owner_insert_denied$
begin
  begin
    insert into public.salons (id, slug, name, phone, feature_flags)
    values (
      '26000000-0000-0000-0000-000000000005',
      'guided-rollout-owner-enabled-insert',
      'Guided Rollout Owner Enabled Insert',
      '+16045550605',
      '{"guided_admin_setup_enabled": true}'::jsonb
    );
    raise exception 'owner unexpectedly inserted Guided Admin Setup enabled';
  exception
    when insufficient_privilege then null;
  end;
end
$owner_insert_denied$;

-- Admin also keeps sibling flags but cannot change the rollout key.
select set_config(
  'request.jwt.claim.sub',
  '16000000-0000-0000-0000-000000000002',
  true
);
update public.salons
set feature_flags = jsonb_set(
  feature_flags,
  '{waitlist_attention_enabled}',
  'true'::jsonb,
  true
)
where id = '26000000-0000-0000-0000-000000000001';

do $admin_denied$
begin
  begin
    update public.salons
    set feature_flags = jsonb_set(
      feature_flags,
      '{guided_admin_setup_enabled}',
      'true'::jsonb,
      true
    )
    where id = '26000000-0000-0000-0000-000000000001';
    raise exception 'admin unexpectedly enabled Guided Admin Setup';
  exception
    when insufficient_privilege then null;
  end;
end
$admin_denied$;

-- Lower salon roles remain denied by the existing owner/admin row policy.
do $lower_roles_denied$
declare
  v_user_id uuid;
  v_affected integer;
begin
  foreach v_user_id in array array[
    '16000000-0000-0000-0000-000000000003'::uuid, -- senior
    '16000000-0000-0000-0000-000000000004'::uuid, -- receptionist
    '16000000-0000-0000-0000-000000000005'::uuid  -- nail_tech
  ] loop
    perform set_config('request.jwt.claim.sub', v_user_id::text, true);
    begin
      update public.salons
      set feature_flags = jsonb_set(
        feature_flags,
        '{guided_admin_setup_enabled}',
        'true'::jsonb,
        true
      )
      where id = '26000000-0000-0000-0000-000000000001';
      get diagnostics v_affected = row_count;
      if v_affected <> 0 then
        raise exception 'lower salon role unexpectedly changed rollout key: %', v_user_id;
      end if;
    exception
      when insufficient_privilege then null;
    end;
  end loop;
end
$lower_roles_denied$;

-- An owner of another tenant gets no target row and no rollout bypass.
select set_config(
  'request.jwt.claim.sub',
  '16000000-0000-0000-0000-000000000007',
  true
);
do $cross_tenant_denied$
declare
  v_affected integer;
begin
  update public.salons
  set feature_flags = jsonb_set(
    feature_flags,
    '{guided_admin_setup_enabled}',
    'true'::jsonb,
    true
  )
  where id = '26000000-0000-0000-0000-000000000001';
  get diagnostics v_affected = row_count;
  if v_affected <> 0 then
    raise exception 'cross-tenant owner unexpectedly changed rollout key';
  end if;
end
$cross_tenant_denied$;

-- A revoked platform row is inert even when the user remains a salon owner.
select set_config(
  'request.jwt.claim.sub',
  '16000000-0000-0000-0000-000000000008',
  true
);
do $revoked_superadmin_denied$
begin
  begin
    update public.salons
    set feature_flags = jsonb_set(
      feature_flags,
      '{guided_admin_setup_enabled}',
      'true'::jsonb,
      true
    )
    where id = '26000000-0000-0000-0000-000000000001';
    raise exception 'revoked SuperAdmin unexpectedly enabled Guided Admin Setup';
  exception
    when insufficient_privilege then null;
  end;
end
$revoked_superadmin_denied$;

-- Active platform SuperAdmin can change the key only on a row the ordinary
-- salon RLS policy already authorizes.
select set_config(
  'request.jwt.claim.sub',
  '16000000-0000-0000-0000-000000000006',
  true
);
update public.salons
set feature_flags = jsonb_set(
  feature_flags,
  '{guided_admin_setup_enabled}',
  'true'::jsonb,
  true
)
where id = '26000000-0000-0000-0000-000000000001';

insert into public.salons (id, slug, name, phone, feature_flags)
values (
  '26000000-0000-0000-0000-000000000006',
  'guided-rollout-superadmin-enabled-insert',
  'Guided Rollout SuperAdmin Enabled Insert',
  '+16045550606',
  '{"guided_admin_setup_enabled": true}'::jsonb
);

do $superadmin_cross_tenant_denied$
declare
  v_affected integer;
begin
  update public.salons
  set feature_flags = jsonb_set(
    feature_flags,
    '{guided_admin_setup_enabled}',
    'true'::jsonb,
    true
  )
  where id = '26000000-0000-0000-0000-000000000002';
  get diagnostics v_affected = row_count;
  if v_affected <> 0 then
    raise exception 'SuperAdmin bypassed the existing salon row policy';
  end if;
end
$superadmin_cross_tenant_denied$;

-- Removing an existing platform override is also a protected rollout change.
select set_config(
  'request.jwt.claim.sub',
  '16000000-0000-0000-0000-000000000001',
  true
);
do $owner_removal_denied$
begin
  begin
    update public.salons
    set feature_flags = feature_flags - 'guided_admin_setup_enabled'
    where id = '26000000-0000-0000-0000-000000000001';
    raise exception 'owner unexpectedly removed the Guided Admin Setup override';
  exception
    when insufficient_privilege then null;
  end;
end
$owner_removal_denied$;

-- A sibling edit that preserves the protected value remains available.
update public.salons
set feature_flags = jsonb_set(
  feature_flags,
  '{loyalty_enabled}',
  'true'::jsonb,
  true
)
where id = '26000000-0000-0000-0000-000000000001';

reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

-- The audited SuperAdmin server action and test helpers use this path.
update public.salons
set feature_flags = jsonb_set(
  feature_flags,
  '{guided_admin_setup_enabled}',
  'true'::jsonb,
  true
)
where id = '26000000-0000-0000-0000-000000000001';

insert into public.salons (id, slug, name, phone, feature_flags)
values (
  '26000000-0000-0000-0000-000000000007',
  'guided-rollout-service-enabled-insert',
  'Guided Rollout Service Enabled Insert',
  '+16045550607',
  '{"guided_admin_setup_enabled": true}'::jsonb
);

reset role;
select set_config('request.jwt.claim.role', '', true);

do $final_proof$
begin
  if (
    select count(*)
    from public.salons
    where id = '26000000-0000-0000-0000-000000000001'
      and feature_flags -> 'guided_admin_setup_enabled' = 'true'::jsonb
      and feature_flags -> 'group_booking_enabled' = 'true'::jsonb
      and feature_flags -> 'waitlist_attention_enabled' = 'true'::jsonb
      and feature_flags -> 'loyalty_enabled' = 'true'::jsonb
  ) <> 1 then
    raise exception 'protected or sibling feature flag state is wrong';
  end if;

  if (
    select count(*)
    from public.salons
    where id = '26000000-0000-0000-0000-000000000002'
      and not (feature_flags ? 'guided_admin_setup_enabled')
  ) <> 1 then
    raise exception 'cross-tenant salon rollout key changed';
  end if;

  if (
    select count(*)
    from public.salons
    where id = '26000000-0000-0000-0000-000000000003'
      and feature_flags = '{}'::jsonb
  ) <> 1 then
    raise exception 'new salon did not retain the default-off empty flags';
  end if;

  if (
    select count(*)
    from public.salons
    where id = '26000000-0000-0000-0000-000000000004'
      and feature_flags -> 'guided_admin_setup_enabled' = 'false'::jsonb
  ) <> 1 then
    raise exception 'explicit false insert was not preserved';
  end if;

  if exists (
    select 1
    from public.salons
    where id = '26000000-0000-0000-0000-000000000005'
  ) then
    raise exception 'blocked owner insert left a salon row behind';
  end if;

  if (
    select count(*)
    from public.salons
    where id in (
      '26000000-0000-0000-0000-000000000006',
      '26000000-0000-0000-0000-000000000007'
    )
      and feature_flags -> 'guided_admin_setup_enabled' = 'true'::jsonb
  ) <> 2 then
    raise exception 'SuperAdmin/service INSERT positive proof failed';
  end if;
end
$final_proof$;

rollback;

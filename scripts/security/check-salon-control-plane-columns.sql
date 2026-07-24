\set ON_ERROR_STOP on

-- Transaction-scoped behavior proof for the throwaway Supabase database used
-- by Migration History Rehearsal.
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
values
  (
    '13000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'control-owner@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '13000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'control-admin@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  );

insert into public.salons (id, slug, name, phone)
values (
  '23000000-0000-0000-0000-000000000001',
  'control-plane-test',
  'Control Plane Test',
  '+16045550400'
);

insert into public.salon_members (salon_id, user_id, role)
values
  (
    '23000000-0000-0000-0000-000000000001',
    '13000000-0000-0000-0000-000000000001',
    'owner'
  ),
  (
    '23000000-0000-0000-0000-000000000001',
    '13000000-0000-0000-0000-000000000002',
    'admin'
  );

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '13000000-0000-0000-0000-000000000002',
  true
);

-- Admin keeps the normal owner/admin settings boundary.
update public.salons
set sms_outbound_enabled = false
where id = '23000000-0000-0000-0000-000000000001';

do $test$
begin
  begin
    update public.salons
    set vertical = 'head_spa'
    where id = '23000000-0000-0000-0000-000000000001';
    raise exception 'admin unexpectedly changed the salon vertical';
  exception
    when insufficient_privilege then null;
  end;
end
$test$;

select set_config(
  'request.jwt.claim.sub',
  '13000000-0000-0000-0000-000000000001',
  true
);

-- Owner may perform the structural change.
update public.salons
set vertical = 'head_spa'
where id = '23000000-0000-0000-0000-000000000001';

do $test$
begin
  begin
    update public.salons
    set subscription_plan = 'premium'
    where id = '23000000-0000-0000-0000-000000000001';
    raise exception 'owner unexpectedly forged subscription state';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.salons
    set email_verified = true
    where id = '23000000-0000-0000-0000-000000000001';
    raise exception 'owner unexpectedly forged email verification';
  exception
    when insufficient_privilege then null;
  end;
end
$test$;

reset role;

-- Trusted service/database paths still update external-system mirrors.
update public.salons
set subscription_plan = 'premium',
    stripe_connect_account_id = 'acct_control_plane_test',
    sms_a2p_registered = true
where id = '23000000-0000-0000-0000-000000000001';

do $test$
begin
  if (
    select count(*)
    from public.salons
    where id = '23000000-0000-0000-0000-000000000001'
      and sms_outbound_enabled = false
      and vertical = 'head_spa'
      and subscription_plan = 'premium'
      and stripe_connect_account_id = 'acct_control_plane_test'
      and sms_a2p_registered = true
  ) <> 1 then
    raise exception 'salon control-plane behavior proof failed';
  end if;
end
$test$;

rollback;

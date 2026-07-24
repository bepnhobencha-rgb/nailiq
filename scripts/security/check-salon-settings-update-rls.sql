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
    '12000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'settings-owner@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '12000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'settings-admin@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '12000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'settings-receptionist@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  );

insert into public.salons (id, slug, name, phone)
values (
  '22000000-0000-0000-0000-000000000001',
  'rls-salon-settings-test',
  'RLS Salon Settings Test',
  '+16045550399'
);

insert into public.salon_members (salon_id, user_id, role)
values
  (
    '22000000-0000-0000-0000-000000000001',
    '12000000-0000-0000-0000-000000000001',
    'owner'
  ),
  (
    '22000000-0000-0000-0000-000000000001',
    '12000000-0000-0000-0000-000000000002',
    'admin'
  ),
  (
    '22000000-0000-0000-0000-000000000001',
    '12000000-0000-0000-0000-000000000003',
    'receptionist'
  );

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '12000000-0000-0000-0000-000000000001',
  true
);

update public.salons
set sms_outbound_enabled = false
where id = '22000000-0000-0000-0000-000000000001';

select set_config(
  'request.jwt.claim.sub',
  '12000000-0000-0000-0000-000000000002',
  true
);

update public.salons
set email_outbound_enabled = false
where id = '22000000-0000-0000-0000-000000000001';

do $test$
declare
  affected_rows integer;
  configured_count integer;
begin
  select count(*) into configured_count
  from public.salons
  where id = '22000000-0000-0000-0000-000000000001'
    and sms_outbound_enabled = false
    and email_outbound_enabled = false;
  if configured_count <> 1 then
    raise exception 'owner/admin did not update salon settings';
  end if;

  perform set_config(
    'request.jwt.claim.sub',
    '12000000-0000-0000-0000-000000000003',
    true
  );

  update public.salons
  set customer_channel = 'sms_only'
  where id = '22000000-0000-0000-0000-000000000001';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'receptionist unexpectedly updated salon settings';
  end if;
end
$test$;

rollback;

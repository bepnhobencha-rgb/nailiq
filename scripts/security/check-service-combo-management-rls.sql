\set ON_ERROR_STOP on

-- Runs only against the transaction-scoped, throwaway Supabase database in
-- Migration History Rehearsal. It proves owner/admin management while a
-- senior staff login and a receptionist retain only the public active-combo
-- read path. `senior` is a staff.job_role; its dashboard permission is stored
-- as `receptionist` in salon_members.
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
    '11000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'combo-owner@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '11000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'combo-admin@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '11000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'combo-senior@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '11000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'combo-receptionist@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  );

insert into public.salons (id, slug, name, phone)
values (
  '21000000-0000-0000-0000-000000000001',
  'rls-combo-test',
  'RLS Combo Test',
  '+16045550299'
);

insert into public.salon_members (salon_id, user_id, role)
values
  (
    '21000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000001',
    'owner'
  ),
  (
    '21000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000002',
    'admin'
  ),
  (
    '21000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000003',
    'receptionist'
  ),
  (
    '21000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000004',
    'receptionist'
  );

insert into public.staff (salon_id, name, job_role, user_id)
values (
  '21000000-0000-0000-0000-000000000001',
  'Combo senior staff',
  'senior',
  '11000000-0000-0000-0000-000000000003'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '11000000-0000-0000-0000-000000000001',
  true
);

insert into public.service_combos (
  id,
  salon_id,
  name,
  service_ids,
  price_cents,
  discount_cents,
  duration_minutes,
  is_active,
  "position"
)
values
  (
    '31000000-0000-4000-8000-000000000001',
    '21000000-0000-0000-0000-000000000001',
    'Owner active combo',
    array[
      '41000000-0000-4000-8000-000000000001'::uuid,
      '41000000-0000-4000-8000-000000000002'::uuid
    ],
    5000,
    500,
    60,
    true,
    0
  ),
  (
    '31000000-0000-4000-8000-000000000002',
    '21000000-0000-0000-0000-000000000001',
    'Owner inactive combo',
    array[
      '41000000-0000-4000-8000-000000000001'::uuid,
      '41000000-0000-4000-8000-000000000002'::uuid
    ],
    6000,
    600,
    75,
    false,
    1
  );

select set_config(
  'request.jwt.claim.sub',
  '11000000-0000-0000-0000-000000000002',
  true
);

update public.service_combos
set name = 'Admin updated combo'
where id = '31000000-0000-4000-8000-000000000002';

do $test$
declare
  affected_rows integer;
  admin_update_count integer;
  visible_count integer;
begin
  select count(*) into admin_update_count
  from public.service_combos
  where id = '31000000-0000-4000-8000-000000000002'
    and name = 'Admin updated combo';
  if admin_update_count <> 1 then
    raise exception 'admin did not update its salon combo';
  end if;

  select set_config(
    'request.jwt.claim.sub',
    '11000000-0000-0000-0000-000000000003',
    true
  );

  select count(*) into visible_count
  from public.service_combos
  where salon_id = '21000000-0000-0000-0000-000000000001';
  if visible_count <> 1 then
    raise exception
      'senior public read boundary failed: expected 1 active combo, saw %',
      visible_count;
  end if;

  update public.service_combos
  set name = 'Senior overwrite'
  where id = '31000000-0000-4000-8000-000000000001';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'senior unexpectedly updated a combo';
  end if;

  begin
    insert into public.service_combos (
      salon_id,
      name,
      service_ids,
      price_cents,
      duration_minutes
    )
    values (
      '21000000-0000-0000-0000-000000000001',
      'Senior insert',
      array[
        '41000000-0000-4000-8000-000000000001'::uuid,
        '41000000-0000-4000-8000-000000000002'::uuid
      ],
      7000,
      90
    );
    raise exception 'senior unexpectedly inserted a combo';
  exception
    when insufficient_privilege then null;
  end;

  select set_config(
    'request.jwt.claim.sub',
    '11000000-0000-0000-0000-000000000004',
    true
  );

  update public.service_combos
  set name = 'Receptionist overwrite'
  where id = '31000000-0000-4000-8000-000000000001';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'receptionist unexpectedly updated a combo';
  end if;
end
$test$;

rollback;

\set ON_ERROR_STOP on

-- Direct authenticated-role behavior proof for the throwaway Supabase
-- database used by Migration History Rehearsal. Every fixture rolls back.
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
    'authenticated', 'authenticated', 'catalog-owner@nailiq.invalid', '',
    now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()
  ),
  (
    '13000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'catalog-admin@nailiq.invalid', '',
    now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()
  ),
  (
    '13000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'catalog-senior@nailiq.invalid', '',
    now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()
  ),
  (
    '13000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'catalog-reception@nailiq.invalid', '',
    now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()
  ),
  (
    '13000000-0000-0000-0000-000000000005',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'catalog-tech@nailiq.invalid', '',
    now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()
  ),
  (
    '13000000-0000-0000-0000-000000000006',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'catalog-other-owner@nailiq.invalid', '',
    now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()
  );

insert into public.salons (id, slug, name, phone)
values
  (
    '23000000-0000-0000-0000-000000000001',
    'rls-setup-catalog-target',
    'RLS Setup Catalog Target',
    '+16045550601'
  ),
  (
    '23000000-0000-0000-0000-000000000002',
    'rls-setup-catalog-other',
    'RLS Setup Catalog Other',
    '+16045550602'
  );

insert into public.salon_members (salon_id, user_id, role)
values
  ('23000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 'owner'),
  ('23000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000002', 'admin'),
  ('23000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000003', 'senior'),
  ('23000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000004', 'receptionist'),
  ('23000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000005', 'nail_tech'),
  ('23000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000006', 'owner');

insert into public.staff (id, salon_id, name, job_role, status)
values
  (
    '33000000-0000-0000-0000-000000000001',
    '23000000-0000-0000-0000-000000000001',
    'Target Artist One', 'nail_tech', 'active'
  ),
  (
    '33000000-0000-0000-0000-000000000002',
    '23000000-0000-0000-0000-000000000001',
    'Target Artist Two', 'senior', 'active'
  ),
  (
    '33000000-0000-0000-0000-000000000003',
    '23000000-0000-0000-0000-000000000002',
    'Other Artist', 'nail_tech', 'active'
  );

insert into public.services (id, salon_id, name, price_cents, duration_minutes)
values
  (
    '43000000-0000-0000-0000-000000000001',
    '23000000-0000-0000-0000-000000000001',
    'Target Service One', 5000, 50
  ),
  (
    '43000000-0000-0000-0000-000000000002',
    '23000000-0000-0000-0000-000000000001',
    'Target Service Two', 6000, 60
  ),
  (
    '43000000-0000-0000-0000-000000000003',
    '23000000-0000-0000-0000-000000000001',
    'Target Service Three', 7000, 70
  ),
  (
    '43000000-0000-0000-0000-000000000004',
    '23000000-0000-0000-0000-000000000002',
    'Other Service', 8000, 80
  );

insert into public.staff_services (staff_id, service_id)
values (
  '33000000-0000-0000-0000-000000000001',
  '43000000-0000-0000-0000-000000000001'
);

-- Public booking reads stay intact. No write policy or table grant is widened.
set local role anon;

do $public_read$
begin
  if (
    select count(*)
    from public.public_service_catalog
    where id = '43000000-0000-0000-0000-000000000001'
      and price_cents = 5000
      and duration_minutes = 50
  ) <> 1 then
    raise exception 'anon public service catalog read changed';
  end if;

  if (
    select count(*)
    from public.staff_services
    where staff_id = '33000000-0000-0000-0000-000000000001'
      and service_id = '43000000-0000-0000-0000-000000000001'
  ) <> 1 then
    raise exception 'anon staff capability read changed';
  end if;
end;
$public_read$;

reset role;
set local role authenticated;

-- Owner and admin retain own-tenant catalog/configuration authority.
select set_config(
  'request.jwt.claim.sub',
  '13000000-0000-0000-0000-000000000001',
  true
);

update public.services
set price_cents = 5100, duration_minutes = 51
where id = '43000000-0000-0000-0000-000000000001';

insert into public.services (
  id, salon_id, name, price_cents, duration_minutes
)
values (
  '43000000-0000-0000-0000-000000000005',
  '23000000-0000-0000-0000-000000000001',
  'Owner Created Service', 9000, 90
);

insert into public.staff_services (staff_id, service_id)
values (
  '33000000-0000-0000-0000-000000000002',
  '43000000-0000-0000-0000-000000000002'
);

select set_config(
  'request.jwt.claim.sub',
  '13000000-0000-0000-0000-000000000002',
  true
);

update public.services
set price_cents = 6200, duration_minutes = 62
where id = '43000000-0000-0000-0000-000000000002';

insert into public.services (
  id, salon_id, name, price_cents, duration_minutes
)
values (
  '43000000-0000-0000-0000-000000000006',
  '23000000-0000-0000-0000-000000000001',
  'Admin Created Service', 9100, 91
);

delete from public.services
where id = '43000000-0000-0000-0000-000000000005';

insert into public.staff_services (staff_id, service_id)
values (
  '33000000-0000-0000-0000-000000000001',
  '43000000-0000-0000-0000-000000000002'
);

update public.staff_services
set service_id = '43000000-0000-0000-0000-000000000003'
where staff_id = '33000000-0000-0000-0000-000000000001'
  and service_id = '43000000-0000-0000-0000-000000000002';

delete from public.staff_services
where staff_id = '33000000-0000-0000-0000-000000000002'
  and service_id = '43000000-0000-0000-0000-000000000002';

do $positive$
begin
  if (
    select count(*)
    from public.services
    where id = '43000000-0000-0000-0000-000000000001'
      and price_cents = 5100
      and duration_minutes = 51
  ) <> 1 or (
    select count(*)
    from public.services
    where id = '43000000-0000-0000-0000-000000000002'
      and price_cents = 6200
      and duration_minutes = 62
  ) <> 1 or (
    select count(*)
    from public.services
    where id = '43000000-0000-0000-0000-000000000006'
  ) <> 1 or (
    select count(*)
    from public.services
    where id = '43000000-0000-0000-0000-000000000005'
  ) <> 0 or (
    select count(*)
    from public.staff_services
    where staff_id = '33000000-0000-0000-0000-000000000001'
      and service_id = '43000000-0000-0000-0000-000000000003'
  ) <> 1 then
    raise exception 'owner/admin own-tenant setup catalog writes failed';
  end if;
end;
$positive$;

-- Run the same full mutation set as senior, receptionist, nail_tech, and an
-- owner from another tenant. Each statement must fail closed at RLS.
reset role;
set local role authenticated;

\set setup_catalog_user_id '13000000-0000-0000-0000-000000000003'
\set setup_catalog_role_label 'senior'
\ir assert-setup-catalog-denied.psql

\set setup_catalog_user_id '13000000-0000-0000-0000-000000000004'
\set setup_catalog_role_label 'receptionist'
\ir assert-setup-catalog-denied.psql

\set setup_catalog_user_id '13000000-0000-0000-0000-000000000005'
\set setup_catalog_role_label 'nail_tech'
\ir assert-setup-catalog-denied.psql

\set setup_catalog_user_id '13000000-0000-0000-0000-000000000006'
\set setup_catalog_role_label 'cross-tenant owner'
\ir assert-setup-catalog-denied.psql

\unset setup_catalog_user_id
\unset setup_catalog_role_label

reset role;

do $final_state$
begin
  if (
    select count(*)
    from public.services
    where id = '43000000-0000-0000-0000-000000000001'
      and price_cents = 5100
      and duration_minutes = 51
  ) <> 1 or (
    select count(*)
    from public.services
    where id = '43000000-0000-0000-0000-000000000003'
  ) <> 1 or (
    select count(*)
    from public.services
    where id = '43000000-0000-0000-0000-000000000099'
  ) <> 0 or (
    select count(*)
    from public.staff_services
    where staff_id = '33000000-0000-0000-0000-000000000001'
      and service_id = '43000000-0000-0000-0000-000000000001'
  ) <> 1 or (
    select count(*)
    from public.staff_services
    where staff_id = '33000000-0000-0000-0000-000000000002'
      and service_id = '43000000-0000-0000-0000-000000000002'
  ) <> 0 then
    raise exception 'denied role changed setup catalog state';
  end if;
end;
$final_state$;

rollback;

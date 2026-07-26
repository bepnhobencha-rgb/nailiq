\set ON_ERROR_STOP on

-- This runs only against the blank throwaway Supabase database created by the
-- migration-history rehearsal. All fixtures are transaction-scoped.
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
    '10000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'rls-owner@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '10000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'rls-admin@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '10000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'rls-receptionist@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  );

insert into public.salons (id, slug, name, phone)
values (
  '20000000-0000-0000-0000-000000000001',
  'rls-public-page-test',
  'RLS Public Page Test',
  '+16045550199'
);

insert into public.salon_members (salon_id, user_id, role)
values
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'owner'
  ),
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000002',
    'admin'
  ),
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000003',
    'receptionist'
  );

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-0000-0000-000000000001',
  true
);

insert into public.salon_page_sections (
  id,
  salon_id,
  type,
  title,
  is_visible,
  sort_order
)
values
  (
    '30000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'hero',
    'Visible owner section',
    true,
    1
  ),
  (
    '30000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000001',
    'about',
    'Hidden owner section',
    false,
    2
  );

insert into public.website_import_jobs (
  id,
  salon_id,
  source_url
)
values (
  '40000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'https://owner.example.invalid'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-0000-0000-000000000002',
  true
);

insert into public.website_import_jobs (
  id,
  salon_id,
  source_url
)
values (
  '40000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000001',
  'https://admin.example.invalid'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-0000-0000-000000000003',
  true
);

do $test$
declare
  visible_count integer;
  hidden_count integer;
  affected_rows integer;
begin
  select count(*) into visible_count
  from public.salon_page_sections
  where salon_id = '20000000-0000-0000-0000-000000000001'
    and is_visible = true;

  select count(*) into hidden_count
  from public.salon_page_sections
  where salon_id = '20000000-0000-0000-0000-000000000001'
    and is_visible = false;

  if visible_count <> 1 or hidden_count <> 0 then
    raise exception
      'receptionist read boundary failed: visible %, hidden %',
      visible_count,
      hidden_count;
  end if;

  update public.salon_page_sections
  set title = 'Receptionist overwrite'
  where id = '30000000-0000-0000-0000-000000000001';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'receptionist unexpectedly updated a public page section';
  end if;

  begin
    insert into public.salon_page_sections (
      salon_id,
      type,
      title,
      is_visible,
      sort_order
    )
    values (
      '20000000-0000-0000-0000-000000000001',
      'gallery',
      'Receptionist insert',
      true,
      3
    );
    raise exception 'receptionist unexpectedly inserted a public page section';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.website_import_jobs (salon_id, source_url)
    values (
      '20000000-0000-0000-0000-000000000001',
      'https://receptionist.example.invalid'
    );
    raise exception 'receptionist unexpectedly created a website import job';
  exception
    when insufficient_privilege then null;
  end;
end
$test$;

rollback;

\set ON_ERROR_STOP on

-- Transaction-scoped behavior proof. Fixtures are never committed.
begin;

insert into public.salons (
  id,
  slug,
  name,
  phone,
  email,
  profile_complete
)
values (
  '24000000-0000-0000-0000-000000000001',
  'public-view-invoker-test',
  'Public View Invoker Test',
  '+16045550500',
  'private-public-view@nailiq.invalid',
  true
);

insert into public.services (
  id,
  salon_id,
  name,
  price_cents,
  duration_minutes
)
values (
  '34000000-0000-0000-0000-000000000001',
  '24000000-0000-0000-0000-000000000001',
  'Public Service',
  2500,
  30
);

insert into public.staff (
  id,
  salon_id,
  name,
  job_role,
  status
)
values (
  '44000000-0000-0000-0000-000000000001',
  '24000000-0000-0000-0000-000000000001',
  'Public Staff',
  'nail_tech',
  'active'
);

insert into public.staff_shifts (
  id,
  staff_id,
  salon_id,
  day_of_week,
  start_time,
  end_time,
  break_start_time,
  break_end_time,
  is_active
)
values (
  '54000000-0000-0000-0000-000000000001',
  '44000000-0000-0000-0000-000000000001',
  '24000000-0000-0000-0000-000000000001',
  'mon',
  '09:00',
  '17:00',
  '12:00',
  '12:30',
  true
);

insert into public.staff_unavailability (
  id,
  staff_id,
  salon_id,
  date,
  reason
)
values (
  '64000000-0000-0000-0000-000000000001',
  '44000000-0000-0000-0000-000000000001',
  '24000000-0000-0000-0000-000000000001',
  current_date + 7,
  'private reason'
);

set local role anon;

do $proof$
begin
  if (
    select count(*)
    from public.public_salon_profiles
    where id = '24000000-0000-0000-0000-000000000001'
  ) <> 1 then
    raise exception 'anon cannot read the public salon profile';
  end if;

  if (
    select count(*)
    from public.public_service_catalog
    where id = '34000000-0000-0000-0000-000000000001'
  ) <> 1 then
    raise exception 'anon cannot read the public service catalog';
  end if;

  if (
    select count(*)
    from public.public_staff_profiles
    where id = '44000000-0000-0000-0000-000000000001'
  ) <> 1 then
    raise exception 'anon cannot read the public staff profile';
  end if;

  if (
    select count(*)
    from public.public_staff_shifts
    where id = '54000000-0000-0000-0000-000000000001'
      and break_start_time = '12:00'::time
      and break_end_time = '12:30'::time
  ) <> 1 then
    raise exception 'anon cannot read the public staff shift and break';
  end if;

  if (
    select count(*)
    from public.public_staff_unavailability
    where id = '64000000-0000-0000-0000-000000000001'
  ) <> 1 then
    raise exception 'anon cannot read the public unavailability date';
  end if;

  begin
    perform email from public.salons limit 1;
    raise exception 'anon unexpectedly read private salon email';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform user_id from public.staff limit 1;
    raise exception 'anon unexpectedly read staff identity';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform reason from public.staff_unavailability limit 1;
    raise exception 'anon unexpectedly read time-off reason';
  exception
    when insufficient_privilege then null;
  end;
end
$proof$;

reset role;
rollback;

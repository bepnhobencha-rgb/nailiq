-- Seed 2 test salons for incremental Front-desk + Basic Mode testing
-- Salon 1: test-nail-no-wix (no Wix, pure NailIQ)
-- Salon 2: test-nail-with-wix (optional Wix integration)

-- 1. Create test salons
insert into public.salons (name, slug, timezone, country, state, city)
values
  ('Test Nail - No Wix', 'test-nail-no-wix', 'America/Vancouver', 'Canada', 'BC', 'Vancouver'),
  ('Test Nail - With Wix', 'test-nail-with-wix', 'America/New_York', 'United States', 'NY', 'New York')
on conflict (slug) do nothing;

-- 2. Create demo staff for each salon
insert into public.staff (salon_id, name, phone, is_owner)
select id, 'Linh', '+1-555-100-0101', true
from public.salons where slug = 'test-nail-no-wix'
on conflict (salon_id, phone) do nothing;

insert into public.staff (salon_id, name, phone, is_owner)
select id, 'Mai', '+1-555-100-0102', false
from public.salons where slug = 'test-nail-no-wix'
on conflict (salon_id, phone) do nothing;

insert into public.staff (salon_id, name, phone, is_owner)
select id, 'Hoa', '+1-555-100-0103', false
from public.salons where slug = 'test-nail-no-wix'
on conflict (salon_id, phone) do nothing;

insert into public.staff (salon_id, name, phone, is_owner)
select id, 'John', '+1-555-200-0201', true
from public.salons where slug = 'test-nail-with-wix'
on conflict (salon_id, phone) do nothing;

insert into public.staff (salon_id, name, phone, is_owner)
select id, 'Sarah', '+1-555-200-0202', false
from public.salons where slug = 'test-nail-with-wix'
on conflict (salon_id, phone) do nothing;

insert into public.staff (salon_id, name, phone, is_owner)
select id, 'Emma', '+1-555-200-0203', false
from public.salons where slug = 'test-nail-with-wix'
on conflict (salon_id, phone) do nothing;

-- 3. Create demo services for each salon
insert into public.services (salon_id, name, duration_minutes, buffer_minutes, price_cents)
select id, 'Manicure', 30, 5, 3000
from public.salons where slug = 'test-nail-no-wix'
on conflict (salon_id, name) do nothing;

insert into public.services (salon_id, name, duration_minutes, buffer_minutes, price_cents)
select id, 'Pedicure', 45, 5, 4000
from public.salons where slug = 'test-nail-no-wix'
on conflict (salon_id, name) do nothing;

insert into public.services (salon_id, name, duration_minutes, buffer_minutes, price_cents)
select id, 'Gel Extension', 60, 5, 6500
from public.salons where slug = 'test-nail-no-wix'
on conflict (salon_id, name) do nothing;

insert into public.services (salon_id, name, duration_minutes, buffer_minutes, price_cents)
select id, 'Nail Art', 45, 5, 5000
from public.salons where slug = 'test-nail-no-wix'
on conflict (salon_id, name) do nothing;

insert into public.services (salon_id, name, duration_minutes, buffer_minutes, price_cents)
select id, 'Manicure', 30, 5, 3500
from public.salons where slug = 'test-nail-with-wix'
on conflict (salon_id, name) do nothing;

insert into public.services (salon_id, name, duration_minutes, buffer_minutes, price_cents)
select id, 'Pedicure', 45, 5, 4500
from public.salons where slug = 'test-nail-with-wix'
on conflict (salon_id, name) do nothing;

insert into public.services (salon_id, name, duration_minutes, buffer_minutes, price_cents)
select id, 'Gel Extension', 60, 5, 7000
from public.salons where slug = 'test-nail-with-wix'
on conflict (salon_id, name) do nothing;

insert into public.services (salon_id, name, duration_minutes, buffer_minutes, price_cents)
select id, 'Nail Art', 45, 5, 5500
from public.salons where slug = 'test-nail-with-wix'
on conflict (salon_id, name) do nothing;

-- 4. Create opening hours (9am-7pm Mon-Sat)
insert into public.salon_hours (salon_id, day_of_week, opens_at, closes_at)
select id, day, '09:00:00', '19:00:00'
from public.salons
cross join (select * from (values (1), (2), (3), (4), (5), (6)) as days(day))
where slug in ('test-nail-no-wix', 'test-nail-with-wix')
on conflict (salon_id, day_of_week) do nothing;

-- 5. Note: salon_members are created automatically on first user login via OTP
-- The staff phone numbers (+1-555-100-0101, +1-555-200-0201) can be used to login
-- In demo mode, OTP is shown on screen instead of being sent via SMS

-- 6. (Optional) Create Wix integration for test-nail-with-wix
-- Using a demo Wix site ID; key will be set via admin UI later
insert into public.wix_integrations (salon_id, site_id, enabled)
select id, 'demo-wix-site-12345', false
from public.salons where slug = 'test-nail-with-wix'
on conflict (salon_id) do nothing;

-- 7. Create demo bookings for testing
-- Upcoming booking in 30 min
insert into public.bookings (salon_id, service_id, staff_id, customer_phone, customer_name, scheduled_for, status)
select
  s.id,
  sv.id,
  st.id,
  '+1-555-100-5001',
  'Alice Demo',
  now() + interval '30 minutes',
  'confirmed'
from public.salons s
join public.services sv on s.id = sv.salon_id and sv.name = 'Manicure'
join public.staff st on s.id = st.salon_id and st.is_owner = true
where s.slug = 'test-nail-no-wix'
on conflict do nothing;

-- Walk-in in progress
insert into public.bookings (salon_id, service_id, staff_id, customer_phone, customer_name, scheduled_for, status)
select
  s.id,
  sv.id,
  st.id,
  '+1-555-100-5002',
  'Bob Walkin',
  now(),
  'in_progress'
from public.salons s
join public.services sv on s.id = sv.salon_id and sv.name = 'Pedicure'
join public.staff st on s.id = st.salon_id and st.name = 'Mai'
where s.slug = 'test-nail-no-wix'
on conflict do nothing;

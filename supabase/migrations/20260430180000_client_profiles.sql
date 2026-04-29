-- Prompt #31: lightweight CRM slice for public booking (phone-keyed profiles).

create table if not exists public.client_profiles (
  id uuid primary key default gen_random_uuid (),
  phone text unique not null,
  name text,
  preferred_staff_id uuid references public.staff (id),
  last_service_date timestamptz,
  visit_count integer default 0,
  created_at timestamptz default now()
);

alter table public.client_profiles enable row level security;

create policy "public read client_profiles"
  on public.client_profiles for select
  using (true);

create policy "public insert client_profiles"
  on public.client_profiles for insert
  with check (true);

create policy "public update client_profiles"
  on public.client_profiles for update
  using (true);

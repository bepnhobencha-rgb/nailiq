-- OTP storage for salon registration (service role only from the app server).
create table if not exists public.otps (
  id         uuid primary key default gen_random_uuid(),
  phone      text not null,
  code       text not null,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

create index if not exists otps_phone_created_idx
  on public.otps (phone, created_at desc);

alter table public.otps enable row level security;

drop policy if exists "otps_service_role_only" on public.otps;
create policy "otps_service_role_only"
  on public.otps
  for all
  using (false)
  with check (false);

-- Short-lived proof that phone OTP succeeded (server exchanges token on salon creation).
create table if not exists public.register_completion_tokens (
  id         uuid primary key default gen_random_uuid(),
  phone      text not null,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

alter table public.register_completion_tokens enable row level security;

drop policy if exists "register_completion_tokens_service_role_only"
  on public.register_completion_tokens;

create policy "register_completion_tokens_service_role_only"
  on public.register_completion_tokens
  for all
  using (false)
  with check (false);

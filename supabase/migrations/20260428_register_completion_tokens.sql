-- Add explicit completion token string (stored client-side after OTP verification).
alter table public.register_completion_tokens
  add column if not exists token text;

update public.register_completion_tokens
set token = gen_random_uuid()::text
where token is null;

alter table public.register_completion_tokens
  alter column token set not null;

create unique index if not exists register_completion_tokens_token_key
  on public.register_completion_tokens (token);

drop policy if exists "service role only" on public.register_completion_tokens;

drop policy if exists "register_completion_tokens_service_role_only"
  on public.register_completion_tokens;

create policy "service role only"
  on public.register_completion_tokens
  for all
  using (false)
  with check (false);

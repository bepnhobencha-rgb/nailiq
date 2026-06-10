-- Self-hosted error monitor (applied to prod 2026-06-10 via MCP; file for parity).
-- Append-only-ish: recurrences of the same error (same fingerprint, still 'open')
-- bump occurrence_count instead of inserting a new row. Writes go through the
-- service-role client via log_error(); reads are gated to superadmins.
create table if not exists public.error_logs (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null,
  level text not null default 'error' check (level in ('fatal','error','warning')),
  message text not null,
  surface text,
  route text,
  salon_id uuid references public.salons(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  stack text,
  context jsonb not null default '{}'::jsonb,
  occurrence_count int not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open','resolved','ignored')),
  ai_summary text,
  ai_suggested_fix text,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null
);

create unique index if not exists error_logs_open_fingerprint_key
  on public.error_logs(fingerprint) where status = 'open';
create index if not exists error_logs_status_lastseen_idx
  on public.error_logs(status, last_seen_at desc);

alter table public.error_logs enable row level security;

drop policy if exists error_logs_superadmin_read on public.error_logs;
create policy error_logs_superadmin_read on public.error_logs
  for select to authenticated
  using (exists (select 1 from public.superadmins s
                 where s.user_id = (select auth.uid()) and s.revoked_at is null));

create or replace function public.log_error(
  p_fingerprint text, p_level text, p_message text, p_surface text,
  p_route text, p_salon_id uuid, p_user_id uuid, p_stack text, p_context jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update public.error_logs
     set occurrence_count = occurrence_count + 1,
         last_seen_at = now(),
         context = coalesce(p_context, context),
         stack = coalesce(nullif(p_stack,''), stack)
   where fingerprint = p_fingerprint and status = 'open'
   returning id into v_id;
  if v_id is null then
    insert into public.error_logs(fingerprint, level, message, surface, route, salon_id, user_id, stack, context)
    values (p_fingerprint, coalesce(nullif(p_level,''),'error'), left(p_message,2000), p_surface,
            p_route, p_salon_id, p_user_id, left(p_stack,8000), coalesce(p_context,'{}'::jsonb))
    returning id into v_id;
  end if;
  return v_id;
end $$;
revoke all on function public.log_error(text,text,text,text,text,uuid,uuid,text,jsonb) from public, anon, authenticated;

comment on table public.error_logs is 'Self-hosted error monitor. Writes via service-role log_error() (dedup by fingerprint while open); reads gated to superadmins.';

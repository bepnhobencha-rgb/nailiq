-- Durable, per-salon claims for paid AI calls. The application uses this only
-- when the rollbackable `ai_rule_first_optimization` feature flag is enabled.
-- Claims are intentionally PII-free and never touch bookings or outbound data.
create table public.ai_execution_limits (
  salon_id uuid not null references public.salons(id) on delete cascade,
  feature text not null check (char_length(feature) between 1 and 80),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 160),
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (salon_id, feature, dedupe_key),
  check (expires_at > claimed_at)
);

create index ai_execution_limits_active_idx
  on public.ai_execution_limits (salon_id, feature, expires_at desc);

alter table public.ai_execution_limits enable row level security;
revoke all on table public.ai_execution_limits from anon, authenticated;
grant select, insert, update on table public.ai_execution_limits to service_role;

create policy "service role manages AI execution limits"
  on public.ai_execution_limits
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.ai_execution_limits is
  'PII-free durable idempotency and rate-limit claims for paid AI calls.';

create or replace function public.claim_ai_execution_slot(
  p_salon_id uuid,
  p_feature text,
  p_dedupe_key text,
  p_window_seconds integer,
  p_max_calls integer
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_rows integer := 0;
begin
  if p_salon_id is null
     or char_length(coalesce(p_feature, '')) not between 1 and 80
     or char_length(coalesce(p_dedupe_key, '')) not between 1 and 160
     or p_window_seconds not between 60 and 2678400
     or p_max_calls not between 1 and 1000 then
    return false;
  end if;

  -- One transaction at a time may count/claim a salon+feature bucket. This
  -- closes the concurrent cron/request race that an application-memory limit
  -- cannot close across Vercel instances.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_salon_id::text || ':' || p_feature, 0)
  );

  if exists (
    select 1
      from public.ai_execution_limits
     where salon_id = p_salon_id
       and feature = p_feature
       and dedupe_key = p_dedupe_key
       and expires_at > v_now
  ) then
    return false;
  end if;

  if (
    select count(*)
      from public.ai_execution_limits
     where salon_id = p_salon_id
       and feature = p_feature
       and expires_at > v_now
  ) >= p_max_calls then
    return false;
  end if;

  insert into public.ai_execution_limits (
    salon_id, feature, dedupe_key, claimed_at, expires_at
  ) values (
    p_salon_id,
    p_feature,
    p_dedupe_key,
    v_now,
    v_now + make_interval(secs => p_window_seconds)
  )
  on conflict (salon_id, feature, dedupe_key) do update
    set claimed_at = excluded.claimed_at,
        expires_at = excluded.expires_at
    where public.ai_execution_limits.expires_at <= v_now;

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke all on function public.claim_ai_execution_slot(
  uuid, text, text, integer, integer
) from public, anon, authenticated;
grant execute on function public.claim_ai_execution_slot(
  uuid, text, text, integer, integer
) to service_role;

comment on function public.claim_ai_execution_slot(
  uuid, text, text, integer, integer
) is 'Atomically claims one PII-free paid-AI slot with durable dedupe and a per-salon feature cap.';

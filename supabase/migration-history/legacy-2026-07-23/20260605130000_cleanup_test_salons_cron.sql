-- Auto-cleanup of leftover E2E/test salons (interrupted test runs leak them).
-- Applied to prod via MCP 2026-06-05; tracked here for reproducibility.
-- Pattern + age guarded: only slugs e2e-/test-/probe- AND older than 2h, so a
-- currently-running test (finishes in minutes) is never touched, and no real
-- tenant slug matches these prefixes.
create or replace function public.cleanup_test_salons()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
  target_ids uuid[];
begin
  select array_agg(id) into target_ids
  from public.salons
  where (slug like 'e2e-%' or slug like 'test-%' or slug like 'probe-%')
    and created_at < now() - interval '2 hours';

  if target_ids is null then
    return 0;
  end if;

  -- NO ACTION FK children must go before the salon delete; the rest cascade.
  delete from public.loyalty_stamp_events where salon_id = any(target_ids);
  delete from public.loyalty_cards        where salon_id = any(target_ids);
  delete from public.loyalty_programs     where salon_id = any(target_ids);
  delete from public.voice_ai_sessions    where salon_id = any(target_ids);

  delete from public.salons where id = any(target_ids);
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Run hourly. Named schedule → re-applying replaces, not duplicates.
select cron.schedule('cleanup-test-salons', '0 * * * *', 'select public.cleanup_test_salons()');

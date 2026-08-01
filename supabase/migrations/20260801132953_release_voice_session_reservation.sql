-- Roll back an atomic Voice AI quota reservation when OpenAI minting or the
-- durable session-row write fails. Service-role only: public callers must never
-- be able to lower their own usage counter.
create or replace function public.release_voice_session_reservation(
  p_salon_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  update public.salons
  set voice_ai_sessions_this_month = greatest(
    0,
    voice_ai_sessions_this_month - 1
  )
  where id = p_salon_id
    and voice_ai_sessions_this_month > 0;

  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$$;

revoke all on function public.release_voice_session_reservation(uuid)
  from public, anon, authenticated;
grant execute on function public.release_voice_session_reservation(uuid)
  to service_role;

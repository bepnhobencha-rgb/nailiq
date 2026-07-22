-- These RPCs are server-only. Keeping EXECUTE on PUBLIC exposes customer PII
-- through PostgREST even though NailIQ only calls them with the service role.
alter function public.winback_candidates(uuid, integer, integer, integer, integer)
  set search_path = public, pg_catalog;

alter function public.rebook_due_candidates(uuid, integer, integer, integer, integer)
  set search_path = public, pg_catalog;

revoke execute on function public.winback_candidates(uuid, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.rebook_due_candidates(uuid, integer, integer, integer, integer)
  from public, anon, authenticated;

grant execute on function public.winback_candidates(uuid, integer, integer, integer, integer)
  to service_role;
grant execute on function public.rebook_due_candidates(uuid, integer, integer, integer, integer)
  to service_role;

-- Trigger functions run through their triggers; they must not also be callable
-- as public RPC endpoints.
revoke execute on function public.log_system_audit()
  from public, anon, authenticated;
grant execute on function public.log_system_audit()
  to service_role;

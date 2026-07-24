\set ON_ERROR_STOP on

-- Emergency rollback rehearsal: remove the trigger and function, verify their
-- absence, then roll back so the throwaway database stays hardened.
begin;

drop trigger if exists salons_protect_control_plane_columns
  on public.salons;
drop function if exists public.enforce_salon_control_plane_columns();

do $test$
begin
  if exists (
    select 1
    from pg_trigger as t
    join pg_class as c on c.oid = t.tgrelid
    join pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'salons'
      and t.tgname = 'salons_protect_control_plane_columns'
      and not t.tgisinternal
  ) then
    raise exception 'salon control-plane rollback left the trigger installed';
  end if;

  if to_regprocedure('public.enforce_salon_control_plane_columns()') is not null then
    raise exception 'salon control-plane rollback left the function installed';
  end if;
end
$test$;

rollback;

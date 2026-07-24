\set ON_ERROR_STOP on

-- Emergency rollback rehearsal: restore the previous audit function body,
-- prove that the control-plane guard is absent while the shared audit trigger
-- still exists, then roll back so the throwaway database stays hardened.
begin;

create or replace function public.log_system_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_salon   uuid;
  v_entity  text;
  v_actor   uuid;
  v_changed jsonb := '{}'::jsonb;
  v_old     jsonb;
  v_new     jsonb;
  k         text;
  v_ignore  text[] := array[
    'updated_at','created_at','last_run_at','cursor_synced_at','last_error',
    'last_synced_at','local_updated_at'
  ];
begin
  if tg_table_name = 'salons' then
    v_salon := (case when tg_op = 'DELETE' then old.id else new.id end);
  else
    begin
      v_salon := (
        case when tg_op = 'DELETE' then old.salon_id else new.salon_id end
      );
    exception when others then
      v_salon := null;
    end;
  end if;

  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
  else
    v_new := to_jsonb(new);
  end if;
  v_entity := coalesce(
    (case when tg_op = 'DELETE' then v_old else v_new end) ->> 'id',
    v_salon::text
  );

  begin
    v_actor := nullif(current_setting('app.actor_user_id', true), '')::uuid;
  exception when others then
    v_actor := null;
  end;

  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    for k in select jsonb_object_keys(v_new) loop
      if k = any(v_ignore)
         or k ~~* '%token%'
         or k ~~* '%secret%'
         or k ~~* '%password%'
         or k ~~* '%access_key%' then
        continue;
      end if;
      if v_old -> k is distinct from v_new -> k then
        v_changed := v_changed || jsonb_build_object(
          k,
          jsonb_build_object('old', v_old -> k, 'new', v_new -> k)
        );
      end if;
    end loop;
    if v_changed = '{}'::jsonb then
      return null;
    end if;
  elsif tg_op = 'INSERT' then
    v_changed := jsonb_build_object('_action', 'created');
  else
    v_changed := jsonb_build_object('_action', 'deleted');
  end if;

  insert into public.system_audit (
    salon_id,
    table_name,
    entity_id,
    action,
    actor_user_id,
    changed_fields
  )
  values (
    v_salon,
    tg_table_name,
    v_entity,
    tg_op,
    v_actor,
    v_changed
  );

  return null;
exception when others then
  return null;
end;
$function$;

do $test$
declare
  function_definition text;
begin
  select pg_get_functiondef('public.log_system_audit()'::regprocedure)
    into function_definition;

  if function_definition like
     '%salon control-plane columns require service-role authorization%' then
    raise exception 'salon control-plane rollback left authorization active';
  end if;

  if not exists (
    select 1
    from pg_trigger as t
    join pg_class as c on c.oid = t.tgrelid
    join pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'salons'
      and t.tgname = 'trg_audit_salons'
      and not t.tgisinternal
  ) then
    raise exception 'salon control-plane rollback removed the shared audit trigger';
  end if;
end
$test$;

rollback;

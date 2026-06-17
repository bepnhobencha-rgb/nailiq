-- General system-change audit log: ANY insert/update/delete on key config tables
-- is captured so the owner can review later. Booking changes already live in
-- booking_events (richer, with actor) — we deliberately do NOT trigger `bookings`
-- here to avoid duplicating that feed. This covers salons / staff / services /
-- square_integrations (settings, prices, team, integrations).

create table if not exists system_audit (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid,
  table_name text not null,
  entity_id text,
  action text not null,                 -- INSERT | UPDATE | DELETE
  actor_user_id uuid,                   -- from app GUC when set, else null
  changed_fields jsonb,                 -- UPDATE: {col: {old, new}}; INSERT/DELETE: {_action}
  created_at timestamptz not null default now()
);

create index if not exists system_audit_salon_created_idx
  on system_audit (salon_id, created_at desc);

-- Service-role only (the app loader reads via service-role AFTER owner-gating).
-- RLS on with no policies = anon/auth see nothing; the SECURITY DEFINER trigger
-- and the service-role client both bypass RLS.
alter table system_audit enable row level security;

create or replace function log_system_audit() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_salon   uuid;
  v_entity  text;
  v_actor   uuid;
  v_changed jsonb := '{}'::jsonb;
  v_old     jsonb;
  v_new     jsonb;
  k         text;
  -- Noisy / machine columns that must never create an audit row on their own.
  v_ignore  text[] := array[
    'updated_at','created_at','last_run_at','cursor_synced_at','last_error',
    'last_synced_at','local_updated_at'
  ];
begin
  -- Resolve the salon this change belongs to.
  if TG_TABLE_NAME = 'salons' then
    v_salon := (case when TG_OP = 'DELETE' then OLD.id else NEW.id end);
  else
    begin
      v_salon := (case when TG_OP = 'DELETE' then OLD.salon_id else NEW.salon_id end);
    exception when others then v_salon := null;
    end;
  end if;

  -- Resolve entity id via jsonb so a table without an `id` column (e.g.
  -- square_integrations, PK = salon_id) never throws; fall back to salon_id.
  if TG_OP = 'DELETE' then v_old := to_jsonb(OLD); else v_new := to_jsonb(NEW); end if;
  v_entity := coalesce(
    (case when TG_OP = 'DELETE' then v_old else v_new end) ->> 'id',
    v_salon::text
  );

  -- Actor (optional): the app may `SET LOCAL app.actor_user_id = '<uuid>'`.
  begin
    v_actor := nullif(current_setting('app.actor_user_id', true), '')::uuid;
  exception when others then v_actor := null;
  end;

  if TG_OP = 'UPDATE' then
    v_old := to_jsonb(OLD);
    for k in select jsonb_object_keys(v_new) loop
      -- Skip noise + NEVER log secrets (token/secret/password/key columns).
      if k = any(v_ignore)
         or k ~~* '%token%' or k ~~* '%secret%'
         or k ~~* '%password%' or k ~~* '%access_key%' then
        continue;
      end if;
      if v_old -> k is distinct from v_new -> k then
        v_changed := v_changed || jsonb_build_object(
          k, jsonb_build_object('old', v_old -> k, 'new', v_new -> k));
      end if;
    end loop;
    if v_changed = '{}'::jsonb then
      return null; -- only noise columns changed (e.g. cron timestamps) → skip
    end if;
  elsif TG_OP = 'INSERT' then
    v_changed := jsonb_build_object('_action', 'created');
  else
    v_changed := jsonb_build_object('_action', 'deleted');
  end if;

  insert into system_audit (salon_id, table_name, entity_id, action, actor_user_id, changed_fields)
  values (v_salon, TG_TABLE_NAME, v_entity, TG_OP, v_actor, v_changed);

  return null;
exception when others then
  -- A failure in audit logging must NEVER block the real write.
  return null;
end;
$$;

drop trigger if exists trg_audit_salons on salons;
create trigger trg_audit_salons after insert or update or delete on salons
  for each row execute function log_system_audit();

drop trigger if exists trg_audit_staff on staff;
create trigger trg_audit_staff after insert or update or delete on staff
  for each row execute function log_system_audit();

drop trigger if exists trg_audit_services on services;
create trigger trg_audit_services after insert or update or delete on services
  for each row execute function log_system_audit();

drop trigger if exists trg_audit_square on square_integrations;
create trigger trg_audit_square after insert or update or delete on square_integrations
  for each row execute function log_system_audit();

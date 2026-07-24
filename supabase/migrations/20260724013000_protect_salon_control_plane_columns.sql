-- The salons row mixes day-to-day business settings with control-plane state.
-- Row-level UPDATE authorization alone cannot prevent an owner/admin token from
-- forging subscription, Stripe, trial, quota, A2P, or SuperAdmin-managed data.
--
-- Reuse the existing salons audit trigger instead of adding another schema
-- object. The function is SECURITY DEFINER, so current_user is the function
-- owner and must never be used to identify the caller. JWT claims retain the
-- original PostgREST identity inside the trigger.

create or replace function public.log_system_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_salon          uuid;
  v_entity         text;
  v_actor          uuid;
  v_membership_role text;
  v_changed        jsonb := '{}'::jsonb;
  v_old            jsonb;
  v_new            jsonb;
  k                text;
  v_ignore         text[] := array[
    'updated_at','created_at','last_run_at','cursor_synced_at','last_error',
    'last_synced_at','local_updated_at'
  ];
begin
  -- The service-role API and trusted direct database jobs have no member
  -- boundary. Authenticated PostgREST writes retain auth.uid() and are checked.
  if tg_table_name = 'salons'
     and tg_op = 'UPDATE'
     and (select auth.role()) is distinct from 'service_role'
     and (select auth.uid()) is not null then
    if exists (
      select 1
      from unnest(array[
        'created_at',
        'stripe_customer_id',
        'stripe_subscription_id',
        'subscription_plan',
        'subscription_status',
        'subscription_current_period_end',
        'plan_override',
        'is_beta',
        'admin_notes',
        'superadmin_locked_at',
        'voice_ai_sessions_this_month',
        'voice_ai_sessions_limit',
        'voice_ai_sessions_reset_at',
        'basic_mode_forced',
        'stripe_connect_account_id',
        'stripe_connect_charges_enabled',
        'stripe_connect_details_submitted',
        'sms_a2p_registered',
        'trial_started_at',
        'trial_ends_at'
      ]) as protected(column_name)
      where to_jsonb(new) -> protected.column_name
        is distinct from to_jsonb(old) -> protected.column_name
    ) then
      raise insufficient_privilege
        using message = 'salon control-plane columns require service-role authorization';
    end if;

    -- A member may invalidate an email while changing it, but only the trusted
    -- verification route may promote the address to verified.
    if new.email_verified is distinct from old.email_verified
       and new.email_verified is true then
      raise insufficient_privilege
        using message = 'email verification requires service-role authorization';
    end if;

    if exists (
      select 1
      from unnest(array[
        'vertical',
        'archived_at',
        'payment_provider'
      ]) as owner_only(column_name)
      where to_jsonb(new) -> owner_only.column_name
        is distinct from to_jsonb(old) -> owner_only.column_name
    ) then
      select sm.role
        into v_membership_role
      from public.salon_members as sm
      where sm.salon_id = old.id
        and sm.user_id = (select auth.uid())
      limit 1;

      if v_membership_role is distinct from 'owner' then
        raise insufficient_privilege
          using message = 'salon structural and payment-provider changes require owner authorization';
      end if;
    end if;
  end if;

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

  -- Resolve entity id via jsonb so a table without an `id` column (for
  -- example square_integrations, whose PK is salon_id) never throws.
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
exception
  -- Authorization is part of the real write and must never be swallowed by
  -- the audit logger's best-effort fallback.
  when insufficient_privilege then
    raise;
  when others then
    return null;
end;
$function$;

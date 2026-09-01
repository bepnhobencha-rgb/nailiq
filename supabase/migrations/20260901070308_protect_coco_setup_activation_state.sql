-- Coco Setup Activation is stamped only by the server-side new-owner
-- registration transaction. It is intentionally separate from the legacy
-- single-disposable-QA `guided_admin_setup_enabled` flag so existing salons
-- remain unchanged and the old rollout guard stays intact.

create or replace function public.protect_guided_admin_setup_rollout_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $protect_guided_setup_flag$
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_guided_old jsonb := case when tg_op = 'INSERT' then null
    else old.feature_flags -> 'guided_admin_setup_enabled' end;
  v_guided_new jsonb := new.feature_flags -> 'guided_admin_setup_enabled';
  v_activation_old jsonb := case when tg_op = 'INSERT' then null
    else old.feature_flags -> 'coco_setup_activation_version' end;
  v_activation_new jsonb := new.feature_flags -> 'coco_setup_activation_version';
  v_allowlisted uuid;
begin
  -- Preserve the exact single-disposable-QA boundary for the legacy Guided
  -- Setup tenant flag.
  if v_guided_old is distinct from v_guided_new then
    if v_guided_new is not null
       and pg_catalog.jsonb_typeof(v_guided_new) <> 'boolean' then
      raise exception using errcode = '22023',
        message = 'guided admin setup flag must be JSON boolean';
    end if;

    if not (
      tg_op = 'INSERT'
      and coalesce(v_guided_new, 'false'::jsonb) <> 'true'::jsonb
    ) then
      if not (
        v_role = 'service_role'
        or (v_role = '' and session_user in ('postgres', 'supabase_admin'))
      ) then
        raise exception using errcode = '42501',
          message = 'guided admin setup rollout requires the dedicated QA setter';
      end if;

      if v_guided_new = 'true'::jsonb then
        select ps.guided_admin_setup_qa_salon_id
        into v_allowlisted
        from public.platform_settings as ps
        where ps.id = 'platform';

        if v_allowlisted is distinct from new.id
           or new.archived_at is not null
           or new.is_beta is not true
           or new.subscription_status not in ('active', 'trialing')
           or lower(trim(new.name)) in ('hi-lite head spa', 'hi-lite studio')
           or lower(trim(new.slug)) in ('hilite-anaheim', 'hilite-studio') then
          raise exception using errcode = '42501',
            message = 'guided admin setup may be enabled only for the configured disposable Salon QA';
        end if;
      end if;
    end if;
  end if;

  if v_activation_old is not distinct from v_activation_new then
    return new;
  end if;

  if v_activation_new is not null and v_activation_new <> '1'::jsonb then
    raise exception using errcode = '22023',
      message = 'coco setup activation version must be 1 or null';
  end if;

  if not (
    v_role = 'service_role'
    or (v_role = '' and session_user in ('postgres', 'supabase_admin'))
  ) then
    raise exception using errcode = '42501',
      message = 'coco setup activation is controlled by new-owner registration';
  end if;

  -- Activation is a one-way registration receipt. Disabling or changing it
  -- requires an explicit future migration/recovery path instead of a generic
  -- salon settings update.
  if tg_op = 'UPDATE' then
    raise exception using errcode = '42501',
      message = 'coco setup activation cannot be changed after registration';
  end if;

  if new.archived_at is not null
     or new.subscription_status not in ('active', 'trialing') then
    raise exception using errcode = '42501',
      message = 'coco setup activation requires an active new salon';
  end if;

  return new;
end;
$protect_guided_setup_flag$;

comment on function public.protect_guided_admin_setup_rollout_flag() is
  'Keeps the disposable-QA Guided Setup flag allowlisted and protects the versioned new-owner Coco Setup receipt from generic mutation.';

revoke all on function public.protect_guided_admin_setup_rollout_flag()
  from public, anon, authenticated;

create or replace function public.save_coco_setup_decision(
  p_salon_id uuid,
  p_capability text,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $save_coco_setup_decision$
declare
  v_user_id uuid := (select auth.uid());
  v_flags jsonb;
  v_decisions jsonb;
begin
  if v_user_id is null then
    return pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;

  if p_capability not in (
    'resource_capacity',
    'multi_service',
    'group_booking',
    'waitlist_walkin',
    'customer_identity_otp',
    'payments_checkout',
    'ai_automation',
    'reporting_alerts'
  ) or p_decision not in ('configured_off', 'not_using') then
    return pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_decision');
  end if;

  if not exists (
    select 1
    from public.salon_members as sm
    where sm.salon_id = p_salon_id
      and sm.user_id = v_user_id
      and sm.role in ('owner', 'admin')
  ) then
    return pg_catalog.jsonb_build_object('success', false, 'code', 'forbidden');
  end if;

  select coalesce(s.feature_flags, '{}'::jsonb)
  into v_flags
  from public.salons as s
  where s.id = p_salon_id
    and s.archived_at is null
    and s.feature_flags ->> 'coco_setup_activation_version' = '1'
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('success', false, 'code', 'not_active');
  end if;

  v_decisions := case
    when pg_catalog.jsonb_typeof(v_flags -> 'coco_setup_decisions') = 'object'
      then v_flags -> 'coco_setup_decisions'
    else '{}'::jsonb
  end;

  update public.salons as s
  set feature_flags = pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_flags,
      '{coco_setup_decisions}',
      v_decisions,
      true
    ),
    array['coco_setup_decisions', p_capability],
    pg_catalog.to_jsonb(p_decision),
    true
  )
  where s.id = p_salon_id;

  return pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'saved',
    'capability', p_capability,
    'decision', p_decision
  );
end;
$save_coco_setup_decision$;

comment on function public.save_coco_setup_decision(uuid, text, text) is
  'Atomically records a reversible Owner/Admin use-or-skip decision for an activated Coco Setup salon.';

revoke all on function public.save_coco_setup_decision(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.save_coco_setup_decision(uuid, text, text)
  to authenticated;

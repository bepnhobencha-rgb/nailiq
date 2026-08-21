-- Registration setup may update an already-created salon only when the
-- authenticated caller has exactly one canonical membership and that row is
-- still the salon owner. Keep the membership re-check, incomplete-state gate,
-- and update in one statement so a service-role caller cannot bypass tenant
-- authorization or revive a completed setup through a stale application read.

create or replace function public.complete_existing_owner_registration_setup(
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_name text,
  p_slug text,
  p_timezone text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated_slug text;
  v_existing_slug text;
  v_completed_at timestamptz;
  v_membership_count bigint;
  v_exact_owner_count bigint;
begin
  if p_salon_id is null
     or p_actor_user_id is null
     or coalesce(length(trim(p_name)), 0) not between 1 and 120
     or coalesce(length(trim(p_slug)), 0) not between 1 and 120
     or trim(p_slug) !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or coalesce(length(trim(p_timezone)), 0) not between 1 and 120 then
    return jsonb_build_object('success', false, 'code', 'invalid_input');
  end if;

  -- Serialize this rare registration completion against membership INSERT,
  -- UPDATE, and DELETE. Without this lock, their RowExclusiveLock can commit
  -- after the UPDATE's statement snapshot was taken, allowing a stale owner or
  -- stale sole-membership check to complete setup. SHARE conflicts with those
  -- writers; once it is acquired, this default-VOLATILE function's following
  -- statement sees the writer's committed membership state under READ COMMITTED.
  lock table public.salon_members in share mode;

  -- The lock plus this UPDATE form the authorization boundary. The service
  -- role may bypass RLS, but it still cannot mutate a salon unless the actor
  -- currently has exactly one membership, that exact row is role=owner for
  -- this salon, and setup is still incomplete at update time.
  update public.salons as salon
     set name = trim(p_name),
         slug = trim(p_slug),
         timezone = trim(p_timezone),
         setup_wizard_completed_at = clock_timestamp()
   where salon.id = p_salon_id
     and salon.setup_wizard_completed_at is null
     and 1 = (
       select count(*)
         from public.salon_members as membership
        where membership.user_id = p_actor_user_id
     )
     and exists (
       select 1
         from public.salon_members as membership
        where membership.user_id = p_actor_user_id
          and membership.salon_id = p_salon_id
          and membership.role = 'owner'
     )
  returning salon.slug into v_updated_slug;

  if found then
    return jsonb_build_object(
      'success', true,
      'code', 'updated',
      'slug', v_updated_slug
    );
  end if;

  -- Explain a safe no-op without performing a second write. These reads are
  -- diagnostics only; authorization already failed closed in the UPDATE.
  select count(*),
         count(*) filter (
           where membership.salon_id = p_salon_id
             and membership.role = 'owner'
         )
    into v_membership_count, v_exact_owner_count
    from public.salon_members as membership
   where membership.user_id = p_actor_user_id;

  if v_membership_count > 1 then
    return jsonb_build_object(
      'success', false,
      'code', 'ambiguous_membership'
    );
  end if;

  if v_membership_count <> 1 or v_exact_owner_count <> 1 then
    return jsonb_build_object('success', false, 'code', 'forbidden');
  end if;

  select salon.slug, salon.setup_wizard_completed_at
    into v_existing_slug, v_completed_at
    from public.salons as salon
   where salon.id = p_salon_id;

  if not found then
    return jsonb_build_object('success', false, 'code', 'salon_not_found');
  end if;

  if v_completed_at is not null then
    return jsonb_build_object(
      'success', true,
      'code', 'already_complete',
      'slug', v_existing_slug
    );
  end if;

  return jsonb_build_object('success', false, 'code', 'state_changed');
end;
$$;

revoke all on function public.complete_existing_owner_registration_setup(
  uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.complete_existing_owner_registration_setup(
  uuid, uuid, text, text, text
) to service_role;

comment on function public.complete_existing_owner_registration_setup(
  uuid, uuid, text, text, text
) is
  'Atomically completes an existing salon setup only for an exact, sole owner membership; service-role only.';

-- Migration-time contract proof: keep this narrow RPC invoker-rights and
-- service-role only. A future broad grant or SECURITY DEFINER change must fail
-- the migration instead of silently widening the registration boundary.
do $proof$
declare
  v_oid oid := to_regprocedure(
    'public.complete_existing_owner_registration_setup(uuid,uuid,text,text,text)'
  );
  v_definition text;
begin
  if v_oid is null then
    raise exception 'complete_existing_owner_registration_setup RPC is missing';
  end if;

  select pg_get_functiondef(v_oid) into v_definition;

  if (select prosecdef from pg_proc where oid = v_oid)
     or position('membership.role = ''owner''' in v_definition) = 0
     or position('lock table public.salon_members in share mode' in v_definition) = 0
     or position('salon.setup_wizard_completed_at is null' in v_definition) = 0
     or position('select count(*)' in v_definition) = 0
     or exists (
       select 1
         from aclexplode(
           coalesce(
             (select proacl from pg_proc where oid = v_oid),
             acldefault(
               'f',
               (select proowner from pg_proc where oid = v_oid)
             )
           )
         )
        where grantee = 0
          and privilege_type = 'EXECUTE'
     )
     or has_function_privilege('anon', v_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_oid, 'EXECUTE')
     or not has_table_privilege(
       'service_role', 'public.salon_members', 'UPDATE'
     )
     or not has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception 'existing-owner registration RPC boundary mismatch';
  end if;
end;
$proof$;

-- Staff-invite reconciliation: when someone signs in (e.g. with Google) and ends
-- up as a NEW auth user that has no membership, but their (verified) email
-- matches a salon_members row held by the invited email-user, move that
-- membership onto the signed-in user so every sign-in method reaches the salon.
-- Applied to prod via MCP 2026-06-06; tracked here for reproducibility.
create or replace function public.claim_salon_memberships_by_email(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_count integer := 0;
begin
  select email into v_email from auth.users where id = p_user_id;
  if v_email is null or v_email = '' then
    return 0;
  end if;

  update public.salon_members m
  set user_id = p_user_id
  from auth.users ou
  where m.user_id = ou.id
    and ou.id <> p_user_id
    and lower(ou.email) = lower(v_email)
    and not exists (
      select 1 from public.salon_members m2
      where m2.salon_id = m.salon_id and m2.user_id = p_user_id
    );
  get diagnostics v_count = row_count;

  update public.staff s
  set user_id = p_user_id
  from auth.users ou
  where s.user_id = ou.id
    and ou.id <> p_user_id
    and lower(ou.email) = lower(v_email)
    and not exists (
      select 1 from public.staff s2
      where s2.salon_id = s.salon_id and s2.user_id = p_user_id
    );

  return v_count;
end;
$$;

revoke all on function public.claim_salon_memberships_by_email(uuid) from public, anon, authenticated;
grant execute on function public.claim_salon_memberships_by_email(uuid) to service_role;

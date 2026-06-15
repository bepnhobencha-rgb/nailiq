-- HIGH-1: claim_salon_memberships_by_email re-points another user's
-- salon_members/staff rows to the caller on email equality alone. It's the
-- OAuth/magic-link "staff invited by email" reconcile — its safety rests on the
-- caller's email being VERIFIED. Enforce that in the DB (defense-in-depth,
-- independent of the GoTrue "Confirm email" toggle). Sole caller is
-- /auth/callback after an OAuth/magic-link sign-in (email_confirmed_at always
-- set), so legit claims are unaffected; an unconfirmed email/password account
-- can no longer claim someone else's memberships.
CREATE OR REPLACE FUNCTION public.claim_salon_memberships_by_email(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_email text;
  v_count integer := 0;
begin
  select email into v_email from auth.users where id = p_user_id;
  if v_email is null or v_email = '' then
    return 0;
  end if;

  -- The caller must have PROVEN control of this email (confirmed).
  if not exists (
    select 1 from auth.users
    where id = p_user_id and email_confirmed_at is not null
  ) then
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
$function$;

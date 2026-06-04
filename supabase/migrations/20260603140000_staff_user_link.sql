-- Unified "Team" model: link a bookable staff row to an optional login account.
--
-- Before this, a salon had TWO disconnected lists:
--   • public.staff          — service providers who take bookings (job_role)
--   • public.salon_members  — login accounts with permissions (owner/admin/receptionist)
-- They shared no key, so the same human appeared twice with no relationship.
--
-- This migration is purely ADDITIVE — no data loss, no change to existing RLS
-- policies, booking integrity (bookings.staff_id) is untouched. It adds an
-- optional FK from staff → auth.users so one person = one staff row that MAY
-- also have a login. Permission level still lives in salon_members.role.

alter table public.staff
  add column if not exists user_id uuid references auth.users (id) on delete set null;

-- At most one staff row per (salon, login) — a login can't be two providers
-- in the same salon. Partial so the many user_id NULLs don't collide.
create unique index if not exists staff_salon_user_unique
  on public.staff (salon_id, user_id)
  where user_id is not null;

create index if not exists staff_user_id_idx
  on public.staff (user_id)
  where user_id is not null;

-- Conservative backfill: link the owner's staff row to the owner's login,
-- but only where the match is unambiguous (exactly one owner staff AND
-- exactly one owner member in the salon). Anything ambiguous is left for
-- the owner to link by hand in the new Team UI.
with owner_staff as (
  select salon_id, (array_agg(id))[1] as staff_id, count(*) as n
  from public.staff
  where job_role = 'owner' and deleted_at is null
  group by salon_id
),
owner_member as (
  select salon_id, (array_agg(user_id))[1] as user_id, count(*) as n
  from public.salon_members
  where role = 'owner'
  group by salon_id
)
update public.staff s
set user_id = om.user_id
from owner_staff os
join owner_member om on om.salon_id = os.salon_id
where s.id = os.staff_id
  and os.n = 1
  and om.n = 1
  and s.user_id is null;

comment on column public.staff.user_id is
  'Optional login account (auth.users) for this team member. NULL = booking-only provider with no dashboard access. Permission level lives in salon_members.role.';

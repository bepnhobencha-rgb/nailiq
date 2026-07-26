-- A Free/trial salon is allowed one active staff member. The application
-- previously required more than one staff row before setting
-- `profile_complete`, which left otherwise-ready salons permanently paused.
--
-- This backfill is idempotent and only enables salons that already have the
-- minimum operational data used by the application: an address, one active
-- service, and one active staff member.
update public.salons as salon
set profile_complete = true
where salon.profile_complete is distinct from true
  and length(btrim(coalesce(salon.address, ''))) > 0
  and exists (
    select 1
    from public.services as service
    where service.salon_id = salon.id
      and service.deleted_at is null
  )
  and exists (
    select 1
    from public.staff as staff_member
    where staff_member.salon_id = salon.id
      and staff_member.deleted_at is null
  );

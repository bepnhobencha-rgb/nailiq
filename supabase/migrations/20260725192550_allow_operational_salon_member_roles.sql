-- NailIQ's permission model includes operational senior and nail-tech
-- memberships. The folded baseline retained an older three-role constraint,
-- which prevented those users (and the permission E2E fixture) from being
-- created.
ALTER TABLE public.salon_members
  DROP CONSTRAINT IF EXISTS salon_members_role_check;

ALTER TABLE public.salon_members
  ADD CONSTRAINT salon_members_role_check
  CHECK (role IN ('owner', 'admin', 'senior', 'receptionist', 'nail_tech'));

COMMENT ON COLUMN public.salon_members.role IS
  'Authorization role: owner, admin, senior, receptionist, or nail_tech.';

-- Per-staff skill tags surfaced on the receptionist dashboard's
-- `StaffAvatar` (e.g. "acrylic", "design", "pedicure", "fast", "junior").
-- The receptionist column needs at-a-glance capability hints for assigning
-- walk-ins; this is read-only on the desk for now (Phase 2 will add an
-- editor in salon setup).
--
-- App-side validation lives in `src/components/ui/StaffAvatar.tsx`
-- (`StaffSkill` enum). DB stores the raw text array so we can extend the
-- enum without a schema migration each time; unknown values are filtered
-- at the boundary in `loadReceptionistCenterData`.
--
-- Empty default + idempotent ADD lets existing rows pick this up without a
-- backfill, and re-running this migration is safe.

ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS skills text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.staff.skills IS
  'Skill tags surfaced on receptionist staff column (StaffAvatar). App-side enum (StaffSkill) is the source of truth for valid values; unknown entries are filtered at read time.';

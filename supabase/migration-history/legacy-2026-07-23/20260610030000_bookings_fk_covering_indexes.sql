-- Covering indexes for bookings FKs used in Front-Desk joins + reference checks.
-- Without these, editing/soft-deleting a service or staff row triggers a full
-- bookings scan to check references, and joins lose an index path as data grows.
-- (Applied to prod 2026-06-10; this file keeps fresh DBs in sync.)
CREATE INDEX IF NOT EXISTS idx_bookings_staff_id ON public.bookings(staff_id);
CREATE INDEX IF NOT EXISTS idx_bookings_service_id ON public.bookings(service_id);
CREATE INDEX IF NOT EXISTS idx_bookings_addon_service_id ON public.bookings(addon_service_id);

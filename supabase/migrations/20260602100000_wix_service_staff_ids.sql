-- Add Wix API identifier columns used for write-back when NailIQ creates/cancels bookings.
-- NULL = no Wix counterpart (services added natively in NailIQ, or staff not yet mapped).

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS wix_service_id  text,
  ADD COLUMN IF NOT EXISTS wix_schedule_id text;

ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS wix_resource_id text;

ALTER TABLE public.wix_integrations
  ADD COLUMN IF NOT EXISTS wix_location_id text;

-- Optional indexes for forward-sync lookups
CREATE INDEX IF NOT EXISTS idx_services_wix_service_id
  ON public.services(wix_service_id) WHERE wix_service_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_wix_resource_id
  ON public.staff(wix_resource_id) WHERE wix_resource_id IS NOT NULL;

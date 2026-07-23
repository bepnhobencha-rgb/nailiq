-- Mark a service as an add-on: hidden from the main booking service list,
-- offered only as an upsell at the review step. Default false.
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS is_addon boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.services.is_addon IS
  'When true, the service is an add-on: excluded from the main service picker, suggested only as an upsell on the booking review step.';

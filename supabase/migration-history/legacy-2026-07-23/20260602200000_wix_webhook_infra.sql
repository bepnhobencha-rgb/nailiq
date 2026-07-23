-- Add webhook tracking to wix_integrations
ALTER TABLE public.wix_integrations
  ADD COLUMN IF NOT EXISTS webhook_url text,
  ADD COLUMN IF NOT EXISTS webhook_id text,        -- returned by Wix after registration
  ADD COLUMN IF NOT EXISTS webhook_registered_at timestamptz,
  ADD COLUMN IF NOT EXISTS webhook_last_received_at timestamptz; -- updated on each webhook delivery

-- Seed webhook URL for tech-nails (the only active tenant)
UPDATE public.wix_integrations
SET webhook_url = 'https://nailiq.ca/api/webhooks/wix'
WHERE site_id = 'bca289a2-f279-4a9a-a484-c036e5f78a34';

COMMENT ON COLUMN public.wix_integrations.webhook_url IS 'URL Wix posts booking events to';
COMMENT ON COLUMN public.wix_integrations.webhook_id IS 'Wix webhook subscription ID for management';
COMMENT ON COLUMN public.wix_integrations.webhook_last_received_at IS 'Set on each real-time webhook receipt — useful for monitoring lag vs polling';

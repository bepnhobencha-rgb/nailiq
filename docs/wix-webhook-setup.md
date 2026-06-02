# Wix Webhook Setup (Manual — Dev Console)

## Why manual?

Wix does not expose a REST API for webhook subscription management to IST (API key) tokens.
All three programmatic endpoints tried returned 404:
- `POST https://www.wixapis.com/apps/v1/webhooks` → 404
- `POST https://www.wixapis.com/webhooks/v1/webhooks` → 404
- `POST https://www.wixapis.com/events/v3/webhook-subscriptions` → 404

Webhook registration must be done through the Wix Dev Console UI.

## Setup Steps

1. Go to [manage.wix.com](https://manage.wix.com) → Select **Tech Nails** site
2. In the left sidebar, go to **Dev Console** (or **Advanced** → **Developer Tools**)
3. Navigate to **Webhooks** → **Add Webhook**
4. Configure:
   - **URL:** `https://nailiq.ca/api/webhooks/wix`
   - **Events to subscribe:**
     - Bookings → `booking.created`
     - Bookings → `booking.updated`
     - Bookings → `booking.cancelled`
     - Bookings → `booking.confirmed` (if available)
5. Save — Wix will display a **webhook secret**

## After Getting the Secret

Add to Vercel environment variables (Production + Preview):

```
WIX_WEBHOOK_SECRET=<secret from Wix Dev Console>
```

Also update the DB to mark the webhook as registered:

```sql
UPDATE public.wix_integrations
SET
  webhook_id = '<webhook-id-from-wix>',
  webhook_registered_at = now()
WHERE site_id = 'bca289a2-f279-4a9a-a484-c036e5f78a34';
```

## Pre-generated Fallback Secret

If Wix allows you to supply your own secret (HMAC), use:

```
573f042736886694d675270b7c9b81b4b8c8e3d89b3558098efa6e192d2c2cda
```

## Webhook Endpoint

The receiver is implemented at:
`src/app/api/webhooks/wix/route.ts`

It validates the `x-wix-signature` header using HMAC-SHA256 and the `WIX_WEBHOOK_SECRET` env var,
then upserts the booking into NailIQ and updates `wix_integrations.webhook_last_received_at`.

## Monitoring Webhook Health

Once live, you can check whether webhooks are flowing or falling back to polling:

```sql
SELECT
  site_id,
  last_run_at,
  webhook_last_received_at,
  EXTRACT(EPOCH FROM (now() - webhook_last_received_at)) / 60 AS minutes_since_last_webhook
FROM public.wix_integrations;
```

If `minutes_since_last_webhook` exceeds ~5 minutes during business hours, webhooks may have stalled
and the 1-minute cron fallback is carrying the load.

# Nail Try-On Pilot Runbook

## Release gate

Keep `nail_tryon_enabled` OFF globally. Enable only one internal test salon,
then one consenting pilot salon after every required check is green.

## Required production configuration

- `OPENAI_API_KEY` is server-only and present in Fly/Vercel production.
- `NAIL_TRYON_QUALITY_MODEL` is set to an approved image-input model.
- `NAIL_TRYON_IMAGE_MODEL=gpt-image-2-2026-04-21` is pinned.
- `CRON_SECRET` is present; `/api/cron/nail-tryon-cleanup` runs hourly.
- Supabase migrations are applied and the `nail-tryon` bucket is private.
- No policy on `storage.objects` grants `anon` access to this bucket.

## Seed and smoke test

1. SuperAdmin enables `nail_tryon_enabled` for the internal salon.
2. Owner opens `/dashboard/{slug}/setup/nail-tryon` and publishes three
   representative designs: solid, French, and detailed art.
3. In an incognito mobile browser, open `/{slug}/try-on`.
4. Confirm consent is required and a 404 is returned for a salon with the flag OFF.
5. Test dark, blurry, multiple-hand, palm-up, and occluded-nail photos; none may
   reach image generation.
6. Test one valid photo, each catalog design, refresh/retry, and a double tap on
   Generate. Only one generation may be recorded per session.
7. Continue to booking and confirm one `booking_nail_looks` row is attached with
   immutable design metadata.
8. Confirm dashboard members can read the attached look but anonymous clients
   cannot query any session, booking-look, event, or cleanup row.
9. Force a test session expiry, run cleanup, and verify both Storage objects are
   removed before the queue row is marked processed.

## Ship criteria

- Required GitHub checks green on the complete stack.
- 20 scripted photos: no false pass for multiple hands or hidden nails.
- 10 successful previews: no added fingers, anatomy edits, text, or logos.
- p95 upload + quality verdict under 12 seconds on pilot mobile connection.
- Generation success at least 90% excluding rejected input.
- No duplicate generation charge during retry/double-click tests.
- No customer image bytes, URLs, tokens, names, phones, or emails in telemetry.
- Owner can disable the flag and immediately remove every public entry point.

## Rollback

1. Set `nail_tryon_enabled=false` for the salon.
2. Leave cleanup cron running until all queued objects are removed.
3. Do not delete migrations or bucket metadata during an incident.
4. Preserve PII-free event/error codes for diagnosis; never export customer images.

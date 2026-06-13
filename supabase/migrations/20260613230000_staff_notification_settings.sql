-- Staff-action CUSTOMER notification settings. When a STAFF member creates /
-- reschedules / cancels / no-shows a booking from the dashboard, this controls
-- which channels the "notify the customer" panel offers, the default language,
-- and whether the toggle starts ON per event. Null = app defaults (panel on,
-- English default, SMS+Email, smart per-event defaults), so existing salons
-- gain the panel with sane behavior.
--
-- Shape (app-validated in src/shared/dashboard/staffNotificationSettings.ts):
--   {
--     "enabled": boolean,
--     "defaultLocale": "en" | "vi",
--     "channels": { "sms": bool, "email": bool },
--     "eventDefaults": { "create": bool, "reschedule": bool, "cancel": bool, "no_show": bool }
--   }
alter table public.salons
  add column if not exists staff_notification_settings jsonb;

-- Per-salon default language for customer-facing messages. Online bookings
-- still override this with the language the customer chose on the site
-- (bookings.client_locale). Default 'en' per the agreed policy.
alter table public.salons
  add column if not exists default_notification_locale text not null default 'en';

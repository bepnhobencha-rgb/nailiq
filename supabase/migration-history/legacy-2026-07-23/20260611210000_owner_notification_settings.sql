-- Owner/admin email notifications for booking events (new / reschedule / cancel
-- / no-show). Per-salon opt-in config stored as JSONB; null = disabled (so every
-- existing salon stays silent until the owner turns it on in Settings).
--
-- Shape (app-validated in src/shared/dashboard/ownerNotificationSettings.ts):
--   {
--     "enabled": boolean,
--     "notifyMembers": boolean,        -- email all owner+admin members
--     "customEmails": string[],        -- extra recipients
--     "events": { "new": bool, "reschedule": bool, "cancel": bool, "no_show": bool }
--   }
alter table public.salons
  add column if not exists owner_notification_settings jsonb;

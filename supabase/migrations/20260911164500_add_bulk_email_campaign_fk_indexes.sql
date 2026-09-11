-- Cover the remaining foreign keys added by the bulk email campaign ledger.
--
-- These indexes are additive and do not enable dispatch or alter salon flags.
-- Rollback: drop the five indexes below after confirming no campaign query or
-- foreign-key maintenance relies on them.

CREATE INDEX marketing_email_campaigns_created_by_idx
  ON public.marketing_email_campaigns(created_by);

CREATE INDEX marketing_email_campaigns_approved_by_idx
  ON public.marketing_email_campaigns(approved_by)
  WHERE approved_by IS NOT NULL;

CREATE INDEX marketing_email_campaign_recipients_client_profile_idx
  ON public.marketing_email_campaign_recipients(client_profile_id);

CREATE INDEX marketing_email_campaign_events_salon_idx
  ON public.marketing_email_campaign_events(salon_id);

CREATE INDEX marketing_email_campaign_events_actor_idx
  ON public.marketing_email_campaign_events(actor_user_id)
  WHERE actor_user_id IS NOT NULL;

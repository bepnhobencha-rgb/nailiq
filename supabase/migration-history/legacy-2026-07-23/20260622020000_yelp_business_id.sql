-- Add Yelp Business ID to salons for the AI Yelp Review Responder agent.
-- Yelp Business ID is the slug/alias in the Yelp business URL, e.g. "hi-lite-head-spa-anaheim".
alter table salons add column if not exists yelp_business_id text;

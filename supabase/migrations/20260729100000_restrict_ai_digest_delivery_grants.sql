-- Supabase default table privileges grant service_role more than the digest
-- acknowledgement path needs. Narrow the new table after creation.

revoke all on table public.ai_digest_deliveries from service_role;
grant select, insert on table public.ai_digest_deliveries to service_role;


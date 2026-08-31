-- Production's table default privileges can grant service_role more access
-- than the SMS settings runtime needs. Revoke inherited direct grants first,
-- then restore only the narrow read/upsert surface proven in disposable QA.

revoke all on table public.salon_sms_template_settings
  from public, anon, authenticated, service_role;

grant select, insert, update on table public.salon_sms_template_settings
  to service_role;

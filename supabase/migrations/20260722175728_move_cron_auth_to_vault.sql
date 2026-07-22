-- Remove the privileged JWT from cron.job command text. Supabase recommends
-- Vault for credentials used by pg_cron + pg_net. This migration deliberately
-- derives the existing token in-database so no credential is committed to git.
do $migration$
declare
  v_job_count integer;
  v_distinct_tokens integer;
  v_token text;
  v_secret_id uuid;
begin
  select
    count(*),
    count(distinct token),
    min(token)
  into v_job_count, v_distinct_tokens, v_token
  from (
    select substring(command from 'Bearer (eyJ[A-Za-z0-9._-]+)') as token
    from cron.job
    where jobname in (
      'cron-birthday-voucher',
      'cron-welcome-back',
      'cron-trend-refresh',
      'cron-pattern-detector'
    )
  ) extracted;

  if v_job_count <> 4 or v_distinct_tokens <> 1 or v_token is null then
    raise exception
      'Refusing cron credential migration: expected 4 jobs sharing one JWT';
  end if;

  select id
  into v_secret_id
  from vault.secrets
  where name = 'nailiq_cron_service_role_key';

  if v_secret_id is null then
    perform vault.create_secret(
      v_token,
      'nailiq_cron_service_role_key',
      'Legacy service-role credential used only by protected NailIQ cron Edge Functions'
    );
  else
    perform vault.update_secret(
      v_secret_id,
      v_token,
      'nailiq_cron_service_role_key',
      'Legacy service-role credential used only by protected NailIQ cron Edge Functions'
    );
  end if;

  perform cron.alter_job(
    job_id := jobid,
    command := format(
      $command$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'nailiq_cron_service_role_key'
          ),
          'Content-Type',
          'application/json'
        ),
        body := '{}'::jsonb
      ) as request_id;
      $command$,
      endpoint
    )
  )
  from (
    values
      ('cron-birthday-voucher', 'https://fshmobzyjhmtvndobwsy.supabase.co/functions/v1/cron-birthday-voucher'),
      ('cron-welcome-back', 'https://fshmobzyjhmtvndobwsy.supabase.co/functions/v1/cron-welcome-back'),
      ('cron-trend-refresh', 'https://fshmobzyjhmtvndobwsy.supabase.co/functions/v1/cron-trend-refresh'),
      ('cron-pattern-detector', 'https://fshmobzyjhmtvndobwsy.supabase.co/functions/v1/pattern-detector')
  ) as desired(jobname, endpoint)
  join cron.job using (jobname);
end
$migration$;

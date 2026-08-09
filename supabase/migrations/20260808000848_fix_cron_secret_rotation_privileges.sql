create or replace function public.rotate_nailiq_cron_secret(p_new_secret text)
returns jsonb
language plpgsql
security definer
set search_path = public, vault, cron, extensions
as $$
declare
  target_secret_id uuid;
  current_job record;
  affected_jobs integer := 0;
  new_command text;
begin
  if p_new_secret is null or p_new_secret not like 'sb_secret_%' then
    raise exception 'invalid modern Supabase secret key';
  end if;

  select id
    into target_secret_id
  from vault.secrets
  where name in ('nailiq_cron_secret_key', 'nailiq_cron_service_role_key')
  order by case when name = 'nailiq_cron_secret_key' then 0 else 1 end
  limit 1;

  if target_secret_id is null then
    raise exception 'cron credential was not found';
  end if;

  perform vault.update_secret(
    target_secret_id,
    p_new_secret,
    'nailiq_cron_secret_key',
    'Modern Supabase secret key for internal pg_cron Edge Function calls'
  );

  for current_job in
    select jobid, jobname
    from cron.job
    where jobname in (
      'cron-birthday-voucher',
      'cron-welcome-back',
      'cron-trend-refresh',
      'cron-pattern-detector'
    )
  loop
    new_command := format(
      $command$
        select net.http_post(
          url := 'https://fshmobzyjhmtvndobwsy.supabase.co/functions/v1/%s',
          headers := jsonb_build_object(
            'apikey',
            (
              select decrypted_secret
              from vault.decrypted_secrets
              where name = 'nailiq_cron_secret_key'
            ),
            'Content-Type',
            'application/json'
          ),
          body := '{}'::jsonb
        ) as request_id;
      $command$,
      case current_job.jobname
        when 'cron-pattern-detector' then 'pattern-detector'
        else current_job.jobname
      end
    );

    perform cron.alter_job(current_job.jobid, command := new_command);
    affected_jobs := affected_jobs + 1;
  end loop;

  if affected_jobs <> 4 then
    raise exception 'expected 4 cron jobs, updated %', affected_jobs;
  end if;

  return jsonb_build_object('rotated', true, 'cron_jobs_updated', affected_jobs);
end;
$$;

revoke all on function public.rotate_nailiq_cron_secret(text) from public;
revoke all on function public.rotate_nailiq_cron_secret(text) from anon;
revoke all on function public.rotate_nailiq_cron_secret(text) from authenticated;
grant execute on function public.rotate_nailiq_cron_secret(text) to service_role;

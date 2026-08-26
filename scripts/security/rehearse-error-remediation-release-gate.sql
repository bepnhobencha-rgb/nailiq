\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, created_at)
values
  ('00000000-0000-4000-8000-000000000901', 'error-qa@nailiq.invalid', now()),
  ('00000000-0000-4000-8000-000000000902', 'error-owner@nailiq.invalid', now());

insert into public.error_logs (
  id,
  fingerprint,
  level,
  message,
  surface,
  route,
  context
)
values (
  '00000000-0000-4000-8000-000000000900',
  'releasegate000900',
  'error',
  'Synthetic local release-gate rehearsal',
  'qa',
  '/qa/error-release-gate',
  '{"fixture":true}'::jsonb
);

do $$
begin
  begin
    update public.error_logs
    set status = 'resolved'
    where id = '00000000-0000-4000-8000-000000000900';
    raise exception 'resolution_without_qa_was_not_blocked';
  exception
    when others then
      if sqlerrm = 'resolution_without_qa_was_not_blocked' then
        raise;
      end if;
      if position('error_resolution_requires_qa_and_product_approval' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end;
$$;

update public.error_logs
set
  remediation_state = 'qa_passed',
  qa_candidate_sha = 'aaa156954b96cf03ad4f24d854d4c301dd73cb85',
  qa_evidence = 'Focused local regression and schema release-gate rehearsal passed.',
  qa_passed_at = now(),
  qa_passed_by = '00000000-0000-4000-8000-000000000901'
where id = '00000000-0000-4000-8000-000000000900';

do $$
begin
  begin
    update public.error_logs
    set status = 'resolved'
    where id = '00000000-0000-4000-8000-000000000900';
    raise exception 'resolution_without_approval_was_not_blocked';
  exception
    when others then
      if sqlerrm = 'resolution_without_approval_was_not_blocked' then
        raise;
      end if;
      if position('error_resolution_requires_qa_and_product_approval' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end;
$$;

update public.error_logs
set
  remediation_state = 'approved',
  resolution_approved_at = now(),
  resolution_approved_by = '00000000-0000-4000-8000-000000000902'
where id = '00000000-0000-4000-8000-000000000900';

update public.error_logs
set
  status = 'resolved',
  resolved_at = now(),
  resolved_by = '00000000-0000-4000-8000-000000000902'
where id = '00000000-0000-4000-8000-000000000900';

do $$
declare
  v_row public.error_logs%rowtype;
begin
  select * into strict v_row
  from public.error_logs
  where id = '00000000-0000-4000-8000-000000000900';

  if v_row.status <> 'resolved'
     or v_row.remediation_state <> 'approved'
     or v_row.qa_candidate_sha <> 'aaa156954b96cf03ad4f24d854d4c301dd73cb85'
     or v_row.qa_passed_at is null
     or v_row.resolution_approved_at is null then
    raise exception 'approved_resolution_material_not_persisted';
  end if;
end;
$$;

rollback;

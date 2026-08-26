-- Make the production error workflow durable and fail closed:
-- detect -> triage/propose -> QA evidence -> product approval -> resolve.
-- This migration deliberately does not add an autonomous fixer, merger,
-- deployment, rollback, provider call, or outbound notification.

alter table public.error_logs
  add column remediation_state text not null default 'detected',
  add column qa_candidate_sha text,
  add column qa_evidence text,
  add column qa_passed_at timestamptz,
  add column qa_passed_by uuid references auth.users(id) on delete set null,
  add column resolution_approved_at timestamptz,
  add column resolution_approved_by uuid references auth.users(id) on delete set null;

update public.error_logs
set remediation_state = case
  when fix_proposal is not null or fix_pr_url is not null then 'fix_proposed'
  when ai_summary is not null then 'triaged'
  else 'detected'
end;

alter table public.error_logs
  add constraint error_logs_remediation_state_check
    check (remediation_state in (
      'detected',
      'triaged',
      'fix_proposed',
      'qa_passed',
      'approved'
    )),
  add constraint error_logs_qa_candidate_sha_check
    check (qa_candidate_sha is null or qa_candidate_sha ~ '^[0-9a-f]{40}$'),
  add constraint error_logs_qa_evidence_length_check
    check (qa_evidence is null or char_length(qa_evidence) between 12 and 2000),
  add constraint error_logs_qa_gate_material_check
    check (
      remediation_state not in ('qa_passed', 'approved')
      or (
        qa_candidate_sha is not null
        and qa_evidence is not null
        and qa_passed_at is not null
        and qa_passed_by is not null
      )
    ),
  add constraint error_logs_resolution_approval_material_check
    check (
      remediation_state <> 'approved'
      or (
        resolution_approved_at is not null
        and resolution_approved_by is not null
      )
    );

create or replace function public.enforce_error_remediation_release_gate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.remediation_state is distinct from old.remediation_state then
    if not (
      (old.remediation_state = 'detected' and new.remediation_state in ('triaged', 'fix_proposed', 'qa_passed'))
      or (old.remediation_state = 'triaged' and new.remediation_state in ('fix_proposed', 'qa_passed'))
      or (old.remediation_state = 'fix_proposed' and new.remediation_state = 'qa_passed')
      or (old.remediation_state = 'qa_passed' and new.remediation_state = 'approved')
    ) then
      raise exception 'invalid_error_remediation_transition:%->%',
        old.remediation_state,
        new.remediation_state;
    end if;
  end if;

  if new.status = 'resolved' and old.status is distinct from 'resolved' then
    if new.remediation_state <> 'approved' then
      raise exception 'error_resolution_requires_qa_and_product_approval';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_error_remediation_release_gate()
  from public, anon, authenticated;
grant execute on function public.enforce_error_remediation_release_gate()
  to service_role;

drop trigger if exists error_logs_remediation_release_gate on public.error_logs;
create trigger error_logs_remediation_release_gate
before update on public.error_logs
for each row
execute function public.enforce_error_remediation_release_gate();

comment on column public.error_logs.remediation_state is
  'Human-gated remediation lifecycle. Approved is required before resolved; no state performs code or production mutations.';
comment on column public.error_logs.qa_evidence is
  'Privacy-safe QA command/check summary for the exact candidate SHA; never customer data or secrets.';

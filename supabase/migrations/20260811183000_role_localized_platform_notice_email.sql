-- Role-scoped, bilingual product notices. This is additive: legacy banners
-- continue to use `target`, while newer notices may name exact salon roles.
alter table public.platform_announcements
  add column if not exists audience_roles text[] not null default '{}'::text[],
  add column if not exists notification_mode text not null default 'in_app',
  add column if not exists email_requested boolean not null default false,
  add column if not exists email_subject_en text,
  add column if not exists email_body_en text,
  add column if not exists email_subject_vi text,
  add column if not exists email_body_vi text;

alter table public.platform_announcements
  drop constraint if exists platform_announcements_audience_roles_check;
alter table public.platform_announcements
  add constraint platform_announcements_audience_roles_check
  check (
    audience_roles <@ array[
      'owner', 'admin', 'receptionist', 'senior', 'nail_tech'
    ]::text[]
  );

alter table public.platform_announcements
  drop constraint if exists platform_announcements_notification_mode_check;
alter table public.platform_announcements
  add constraint platform_announcements_notification_mode_check
  check (notification_mode in ('silent', 'in_app', 'digest', 'important'));

alter table public.platform_announcements
  drop constraint if exists platform_announcements_email_copy_check;
alter table public.platform_announcements
  add constraint platform_announcements_email_copy_check
  check (
    not email_requested or (
      notification_mode = 'important'
      and nullif(btrim(email_subject_en), '') is not null
      and nullif(btrim(email_body_en), '') is not null
      and nullif(btrim(email_subject_vi), '') is not null
      and nullif(btrim(email_body_vi), '') is not null
      and cardinality(audience_roles) > 0
    )
  );

comment on column public.platform_announcements.audience_roles is
  'Exact salon membership roles affected. Empty keeps legacy target behavior.';
comment on column public.platform_announcements.email_requested is
  'Manual Superadmin decision to email affected accounts. Only important notices qualify.';

create table if not exists public.platform_announcement_deliveries (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.platform_announcements(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  matched_roles text[] not null default '{}'::text[],
  language text,
  status text not null default 'queued',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  provider_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_announcement_deliveries_unique_user
    unique (announcement_id, user_id),
  constraint platform_announcement_deliveries_language_check
    check (language is null or language in ('en', 'vi')),
  constraint platform_announcement_deliveries_status_check
    check (status in ('queued', 'sending', 'sent', 'failed', 'skipped', 'cancelled')),
  constraint platform_announcement_deliveries_attempt_check
    check (attempt_count between 0 and 3),
  constraint platform_announcement_deliveries_roles_check
    check (
      matched_roles <@ array[
        'owner', 'admin', 'receptionist', 'senior', 'nail_tech'
      ]::text[]
    )
);

create index if not exists platform_announcement_deliveries_due_idx
  on public.platform_announcement_deliveries (next_attempt_at, created_at)
  where status in ('queued', 'failed', 'sending') and attempt_count < 3;

alter table public.platform_announcement_deliveries enable row level security;
revoke all privileges on table public.platform_announcement_deliveries
  from public, anon, authenticated;
grant all privileges on table public.platform_announcement_deliveries
  to service_role;

create policy "deny direct API access to platform announcement deliveries"
  on public.platform_announcement_deliveries
  as restrictive for all to anon, authenticated
  using (false) with check (false);

create or replace function public.queue_platform_announcement_deliveries(
  p_announcement_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  inserted_count integer := 0;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise insufficient_privilege
      using message = 'service role required';
  end if;

  insert into public.platform_announcement_deliveries (
    announcement_id,
    user_id,
    matched_roles
  )
  select
    a.id,
    m.user_id,
    array_agg(distinct m.role order by m.role)
  from public.platform_announcements a
  join public.salon_members m
    on m.role = any(a.audience_roles)
  join public.salons s
    on s.id = m.salon_id
   and s.archived_at is null
  where a.id = p_announcement_id
    and a.email_requested = true
    and a.notification_mode = 'important'
  group by a.id, m.user_id
  on conflict (announcement_id, user_id) do update
    set status = 'queued',
        attempt_count = 0,
        next_attempt_at = now(),
        claimed_at = null,
        last_error = null,
        updated_at = now()
    where platform_announcement_deliveries.status = 'cancelled';

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$function$;

revoke all on function public.queue_platform_announcement_deliveries(uuid)
  from public, anon, authenticated;
grant execute on function public.queue_platform_announcement_deliveries(uuid)
  to service_role;

comment on table public.platform_announcement_deliveries is
  'Service-role-only queue for manually approved, role-scoped product notice emails.';

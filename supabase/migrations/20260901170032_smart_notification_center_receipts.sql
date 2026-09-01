-- Cross-device read state for in-app platform notices. Email delivery truth
-- remains in platform_announcement_deliveries; this table is UI state only.
create table public.platform_announcement_receipts (
  announcement_id uuid not null
    references public.platform_announcements(id) on delete cascade,
  user_id uuid not null
    references auth.users(id) on delete cascade,
  seen_at timestamptz,
  snoozed_until timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (announcement_id, user_id),
  constraint platform_announcement_receipts_dismissed_requires_seen
    check (dismissed_at is null or seen_at is not null)
);

create index platform_announcement_receipts_user_active_idx
  on public.platform_announcement_receipts (user_id, announcement_id)
  where dismissed_at is null;

create index platform_announcement_receipts_user_snoozed_idx
  on public.platform_announcement_receipts (user_id, snoozed_until)
  where dismissed_at is null and snoozed_until is not null;

alter table public.platform_announcement_receipts enable row level security;

revoke all privileges on table public.platform_announcement_receipts
  from public, anon, authenticated;
grant select, insert, update on table public.platform_announcement_receipts
  to authenticated;
grant all privileges on table public.platform_announcement_receipts
  to service_role;

create policy "Users read their own platform notice receipts"
  on public.platform_announcement_receipts
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users create their own platform notice receipts"
  on public.platform_announcement_receipts
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users update their own platform notice receipts"
  on public.platform_announcement_receipts
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create trigger set_platform_announcement_receipts_updated_at
  before update on public.platform_announcement_receipts
  for each row execute function public.set_updated_at();

comment on table public.platform_announcement_receipts is
  'Per-user, cross-device seen, snoozed, and dismissed state for in-app platform notices.';

create table public.platform_notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  auto_manage_routine boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.platform_notification_preferences is
  'Per-user Coco Decision Center preferences. Auto-manage applies only to routine informational product notices and never authorizes provider, messaging, booking, or payment mutations.';

alter table public.platform_notification_preferences enable row level security;

revoke all privileges on table public.platform_notification_preferences
  from public, anon, authenticated;
grant select, insert, update on table public.platform_notification_preferences
  to authenticated;
grant all privileges on table public.platform_notification_preferences
  to service_role;

create policy "Users read their own platform notice preferences"
  on public.platform_notification_preferences
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users create their own platform notice preferences"
  on public.platform_notification_preferences
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users update their own platform notice preferences"
  on public.platform_notification_preferences
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create trigger set_platform_notification_preferences_updated_at
  before update on public.platform_notification_preferences
  for each row execute function public.set_updated_at();

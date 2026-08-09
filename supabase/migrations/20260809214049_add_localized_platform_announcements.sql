-- Keep the original title/body columns as the English/default fallback so
-- existing announcements continue to render during and after rollout.
alter table public.platform_announcements
  add column if not exists title_en text,
  add column if not exists body_en text,
  add column if not exists title_vi text,
  add column if not exists body_vi text;

comment on column public.platform_announcements.title_en is
  'English announcement title. Falls back to legacy title when null.';
comment on column public.platform_announcements.body_en is
  'English announcement body. Falls back to legacy body when null.';
comment on column public.platform_announcements.title_vi is
  'Vietnamese announcement title. Falls back to English/default when null.';
comment on column public.platform_announcements.body_vi is
  'Vietnamese announcement body. Falls back to English/default when null.';

update public.platform_announcements
set
  title_en = coalesce(title_en, title),
  body_en = coalesce(body_en, body)
where title_en is null or body_en is null;

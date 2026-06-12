-- Multi-language notification foundation
-- Goal: transactional SMS in the language the customer was browsing, and scale
-- to 10+ languages WITHOUT a schema/code change per language.
--
-- Design rules (see CLAUDE.md no-hardcode + reusable-modules):
--   * locale columns are FREE BCP-47 text — intentionally NO check constraint,
--     unlike the legacy customer_preferences/ai_chats CHECKs (vi,en,fr) that do
--     not scale. Adding a language must never require a migration.
--   * message bodies live in data (notification_templates), not in code.

-- 1) Persist the customer's active UI locale on each booking.
alter table public.bookings
  add column if not exists client_locale text;

comment on column public.bookings.client_locale is
  'BCP-47 locale the customer was browsing when they booked (e.g. en, vi, es, fr, zh). Drives the language of transactional SMS. No CHECK by design — scales to any number of languages.';

-- 2) Data-driven, localized notification templates.
--    Adding a language = INSERT rows. No deploy, no migration.
create table if not exists public.notification_templates (
  template_key text not null,
  locale       text not null,
  channel      text not null default 'sms',
  body         text not null,
  updated_at   timestamptz not null default now(),
  primary key (template_key, locale, channel)
);

comment on table public.notification_templates is
  'Localized bodies for transactional notifications. Keyed by (template_key, locale, channel). Placeholders: {name} {salon} {when} {service}. Locale has no CHECK so any BCP-47 code scales without migration. Sender resolves locale -> base language -> default with graceful fallback.';

-- Service-role (edge functions / server actions) bypasses RLS for sending.
-- Lock the table down: RLS on, no anon/auth policies (deny by default).
alter table public.notification_templates enable row level security;

-- 3) Seed the booking_reschedule template. Two languages today; more = INSERT.
insert into public.notification_templates (template_key, locale, channel, body) values
  ('booking_reschedule', 'en', 'sms',
   'Hi {name}, this is {salon}. Your {service} appointment has been rescheduled to {when}. See you then!'),
  ('booking_reschedule', 'vi', 'sms',
   'Chào {name}, {salon} xin báo: lịch hẹn {service} của bạn đã được dời sang {when}. Hẹn gặp bạn!')
on conflict (template_key, locale, channel) do update
  set body = excluded.body, updated_at = now();

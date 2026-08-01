-- Keep the phone receptionist's opening language independent from staff/customer
-- notification locale. Notifications currently support a narrower language set.
alter table public.salons
  add column if not exists voice_ai_default_language text not null default 'en';

alter table public.salons
  drop constraint if exists salons_voice_ai_default_language_check;

alter table public.salons
  add constraint salons_voice_ai_default_language_check
  check (voice_ai_default_language in ('vi', 'en', 'es', 'fr', 'zh'));

comment on column public.salons.voice_ai_default_language is
  'Language used for the AI receptionist opening greeting; the bridge can switch languages mid-call.';

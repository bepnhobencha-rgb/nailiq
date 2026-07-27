-- Keep the receptionist inside the salon-admin-approved language set. Existing
-- salons retain all currently supported languages until an owner/admin narrows
-- the list in Voice AI Settings.
alter table public.salons
  add column if not exists voice_ai_allowed_languages text[] not null
  default array['vi', 'en', 'es', 'fr', 'zh']::text[];

alter table public.salons
  drop constraint if exists salons_voice_ai_allowed_languages_check;

alter table public.salons
  add constraint salons_voice_ai_allowed_languages_check
  check (
    cardinality(voice_ai_allowed_languages) > 0
    and voice_ai_allowed_languages <@ array['vi', 'en', 'es', 'fr', 'zh']::text[]
    and voice_ai_default_language = any(voice_ai_allowed_languages)
  );

comment on column public.salons.voice_ai_allowed_languages is
  'Languages the phone AI receptionist may use; the default language must be included.';

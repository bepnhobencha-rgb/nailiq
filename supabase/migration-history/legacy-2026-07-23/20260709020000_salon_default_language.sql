-- Per-salon fallback booking language.
--
-- `resolveBookingLanguage` ends in a hardcoded "vi" (NailIQ's primary market).
-- For a US salon that is wrong when the visitor sends no Accept-Language at all
-- — a Toll-Free reviewer's tooling, a crawler, curl — which then reads the
-- opt-in disclosure in Vietnamese.
--
-- This is the LAST fallback only. `?lang=`, the language cookie, and an explicit
-- Accept-Language all still win, so a Vietnamese-speaking customer booking with
-- an Anaheim salon keeps seeing Vietnamese.
alter table public.salons
  add column if not exists default_language text
    constraint salons_default_language_check
      check (default_language in ('en', 'vi'));

comment on column public.salons.default_language is
  'Fallback booking language when no ?lang, cookie, or Accept-Language signal exists. NULL → ''vi''.';

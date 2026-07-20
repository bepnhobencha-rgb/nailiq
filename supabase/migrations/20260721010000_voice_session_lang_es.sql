-- Allow Spanish voice sessions. The CHECK on voice_ai_sessions.language listed
-- vi/en/fr/zh; a Spanish phone call's session insert would fail the constraint
-- and — because that insert is best-effort/try-caught — silently leave the call
-- unrecorded. Widen it to match SUPPORTED_LANGUAGES (adds 'es').
alter table public.voice_ai_sessions
  drop constraint if exists voice_ai_sessions_language_check;

alter table public.voice_ai_sessions
  add constraint voice_ai_sessions_language_check
  check (language = any (array['vi', 'en', 'es', 'fr', 'zh']));

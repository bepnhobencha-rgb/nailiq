-- Additive observability metadata for Nail Try-On. All affected tables are
-- already service-role-only with RLS enabled; this migration does not widen
-- grants or expose customer images/session data through the Data API.

alter table public.ai_usage_events
  add column correlation_id text
    check (
      correlation_id is null
      or char_length(correlation_id) between 1 and 160
    );

create index ai_usage_events_correlation_created_idx
  on public.ai_usage_events (correlation_id, created_at desc)
  where correlation_id is not null;

comment on column public.ai_usage_events.correlation_id is
  'PII-free internal correlation key, such as a Nail Try-On session UUID.';

alter table public.nail_tryon_sessions
  add column quality_prompt_version text
    check (
      quality_prompt_version is null
      or char_length(quality_prompt_version) between 1 and 80
    ),
  add column generation_prompt_version text
    check (
      generation_prompt_version is null
      or char_length(generation_prompt_version) between 1 and 80
    );

comment on column public.nail_tryon_sessions.quality_prompt_version is
  'Version of the photo-quality prompt used for this session.';

comment on column public.nail_tryon_sessions.generation_prompt_version is
  'Version of the image-edit prompt used for this session.';

-- Persist bounded OpenAI Realtime token counters and the resolved model for
-- each Voice AI session. The application derives estimated_cost_usd from this
-- raw usage using a server-owned, dated rate card; callers never submit cost.

alter table public.voice_ai_sessions
  add column if not exists model text,
  add column if not exists realtime_usage jsonb not null default '{}'::jsonb;

-- Six decimal places preserve short-session estimates that previously rounded
-- to 0.0000. This is a precision widening only; no existing value is changed.
alter table public.voice_ai_sessions
  alter column estimated_cost_usd type numeric(12, 6)
  using estimated_cost_usd::numeric(12, 6),
  alter column estimated_cost_usd drop default;

comment on column public.voice_ai_sessions.model is
  'Resolved OpenAI Realtime model used by this session.';
comment on column public.voice_ai_sessions.realtime_usage is
  'Bounded aggregate token counters only; never transcript or tool content.';

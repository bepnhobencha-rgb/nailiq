create table if not exists public.client_ai_summaries (
  salon_id uuid not null,
  client_profile_id uuid not null,
  summary_text text,
  next_action text,
  visit_count int,
  computed_at timestamptz,
  primary key (salon_id, client_profile_id)
);

alter table public.client_ai_summaries enable row level security;
revoke all on public.client_ai_summaries from anon, authenticated;

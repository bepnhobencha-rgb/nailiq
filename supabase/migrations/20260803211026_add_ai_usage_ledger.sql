-- Additive, service-role-only ledger for model usage. This table is deliberately
-- outside every customer-facing path: failed telemetry writes must never affect
-- an AI decision, booking, message, or active salon workflow.
create table public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid references public.salons(id) on delete set null,
  provider text not null check (provider in ('anthropic', 'openai')),
  feature text not null check (char_length(feature) between 1 and 80),
  model text not null check (char_length(model) between 1 and 120),
  status text not null check (status in ('succeeded', 'failed')),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cache_read_input_tokens bigint not null default 0
    check (cache_read_input_tokens >= 0),
  cache_creation_input_tokens bigint not null default 0
    check (cache_creation_input_tokens >= 0),
  estimated_cost_usd numeric(12, 6)
    check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  latency_ms integer not null check (latency_ms >= 0),
  error_code text check (error_code is null or char_length(error_code) <= 120),
  created_at timestamptz not null default now()
);

create index ai_usage_events_salon_created_idx
  on public.ai_usage_events (salon_id, created_at desc);

create index ai_usage_events_feature_created_idx
  on public.ai_usage_events (feature, created_at desc);

alter table public.ai_usage_events enable row level security;

revoke all on table public.ai_usage_events from anon, authenticated;
grant all on table public.ai_usage_events to service_role;

create policy "service role manages AI usage events"
  on public.ai_usage_events
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.ai_usage_events is
  'PII-free, service-role-only usage and cost ledger for paid model calls.';

comment on column public.ai_usage_events.estimated_cost_usd is
  'Best-effort estimate from the pricing snapshot encoded by the application; provider billing remains authoritative.';

-- Alert-only policy. It never throttles, disables, reroutes, or otherwise
-- changes model behavior. A policy exists only after an operator intentionally
-- configures one; the dashboard reports unconfigured tenants truthfully.
create table public.ai_budget_policies (
  salon_id uuid primary key references public.salons(id) on delete cascade,
  monthly_budget_usd numeric(12, 2) not null check (monthly_budget_usd > 0),
  warning_percent smallint not null default 80
    check (warning_percent between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_budget_policies enable row level security;

revoke all on table public.ai_budget_policies from anon, authenticated;
grant all on table public.ai_budget_policies to service_role;

create policy "service role manages AI budget policies"
  on public.ai_budget_policies
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.ai_budget_policies is
  'Internal alert thresholds only. Exceeding a budget never changes runtime AI behavior.';

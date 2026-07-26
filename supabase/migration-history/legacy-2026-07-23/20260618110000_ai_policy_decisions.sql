-- AI policy agent decisions (shadow + live). The first "AI brain on a
-- deterministic spine" — an agent decides the no-show protection per booking;
-- in SHADOW mode it only RECORDS what it would do (vs the current rule) so the
-- owner can review the quality on real data before granting it real authority.
create table if not exists ai_policy_decisions (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid,
  booking_id uuid,
  agent text not null,            -- 'noshow_policy'
  mode text not null,             -- 'shadow' | 'live'
  ai_protection text,             -- none | card | deposit
  ai_fee_percent integer,
  ai_reason text,
  ai_message text,
  ai_confidence text,             -- low | medium | high
  rule_protection text,           -- what the existing deterministic rule chose
  applied boolean not null default false,
  created_at timestamptz not null default now(),
  -- FK so the activity feed can embed bookings(client_name) via PostgREST.
  constraint ai_policy_decisions_booking_fk
    foreign key (booking_id) references bookings(id) on delete set null
);

create index if not exists ai_policy_decisions_salon_created_idx
  on ai_policy_decisions (salon_id, created_at desc);

-- Service-role only (the activity feed reads it after owner-gating).
alter table ai_policy_decisions enable row level security;

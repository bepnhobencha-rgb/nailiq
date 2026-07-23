-- AI Watchdog — proactive owner alerts. A daily-ish agent scans each salon's
-- recent operational data and, when something is off (no-show spike, protection
-- gap, sync stuck, demand drop, empty schedule), AI judges severity + writes a
-- plain-language alert the owner reviews in the Activity feed. Same spine as the
-- no-show agent: gather → AI judges → deterministic guard (dedupe/severity/cap)
-- → log. AI never acts — it only surfaces; the owner decides.
create table if not exists watchdog_alerts (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid,
  kind text not null,             -- no_show_spike | protection_gap | sync_stuck | low_bookings | demand_drop | other
  severity text not null,         -- info | warning | critical
  title text not null,
  body text,
  dedupe_key text,                -- kind + time-bucket, to avoid repeating the same alert
  snapshot jsonb,                 -- the metrics the AI judged (audit)
  acknowledged_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists watchdog_alerts_salon_created_idx
  on watchdog_alerts (salon_id, created_at desc);
alter table watchdog_alerts enable row level security;

-- Per-salon last-run marker so the watchdog throttles to ~once/12h even though
-- it piggybacks on the every-5-min square-sync cron.
create table if not exists watchdog_state (
  salon_id uuid primary key,
  last_run_at timestamptz
);
alter table watchdog_state enable row level security;

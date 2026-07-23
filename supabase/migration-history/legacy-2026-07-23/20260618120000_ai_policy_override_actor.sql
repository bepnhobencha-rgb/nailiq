-- Override support for the AI no-show policy agent.
-- A human at the desk can disagree with the agent's LIVE decision and flip the
-- card requirement. We log that as an ai_policy_decisions row with mode
-- 'override' so the Activity feed shows the full story (AI suggested X → person
-- changed it to Y) — and stamp WHO did it so it's attributable, like every other
-- desk action. (mode has no CHECK constraint, so 'override' is already allowed.)
alter table ai_policy_decisions
  add column if not exists actor_user_id uuid;

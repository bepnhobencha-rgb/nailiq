-- Per-direction, per-operation Square sync toggles (admin-controllable).
-- Two directions × three operations = 6 switches:
--   PULL  (Square → NailIQ): create / update / cancel  — default TRUE (the
--          forward cron has always done all three; keep current behaviour).
--   PUSH  (NailIQ → Square): create / update / cancel  — default FALSE (opt-in;
--          writes to the salon's live Square calendar, so admin enables each).
alter table square_integrations
  add column if not exists sync_pull_create boolean not null default true,
  add column if not exists sync_pull_update boolean not null default true,
  add column if not exists sync_pull_cancel boolean not null default true,
  add column if not exists sync_push_create boolean not null default false,
  add column if not exists sync_push_update boolean not null default false,
  add column if not exists sync_push_cancel boolean not null default false;

-- Carry the earlier standalone flag forward so a salon that had reverse-create
-- enabled keeps it after the switch to the unified toggle set.
update square_integrations
  set sync_push_create = true
  where reverse_create_enabled = true;

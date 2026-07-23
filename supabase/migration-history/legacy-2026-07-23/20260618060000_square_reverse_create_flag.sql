-- NailIQ → Square reverse-create (Tầng 2) opt-in flag.
-- When true, the square-sync cron mirrors NailIQ-created bookings INTO Square so
-- the slot is reflected on the Square calendar (prevents Square-side double-book).
-- Default FALSE: a mirrored booking can trigger Square's own customer
-- confirmation, so a salon must first confirm its Square notification settings
-- (else the guest is double-texted) before enabling.
alter table square_integrations
  add column if not exists reverse_create_enabled boolean not null default false;

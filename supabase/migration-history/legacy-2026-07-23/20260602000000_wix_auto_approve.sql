-- Smart auto-approve for synced Wix-pending bookings.
-- When on, the forward-sync cron auto-confirms low-risk Wix requests (VIP / trusted
-- returning / no-show risk below the salon's OTP threshold) and writes the Confirm back
-- to Wix; risky / new customers stay 'pending' (amber) for manual Approve/Decline.
alter table public.wix_integrations
  add column if not exists auto_approve boolean not null default true;

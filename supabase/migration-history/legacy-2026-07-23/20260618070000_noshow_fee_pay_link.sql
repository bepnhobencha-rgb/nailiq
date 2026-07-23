-- Customer-pays-their-own no-show-fee via a Square hosted payment link.
-- The order id is the reconcile key: reconcileNoShowFeeLinks (square-sync cron)
-- flips the fee to 'charged' once the customer pays the link.
alter table bookings
  add column if not exists noshow_fee_link_url text,
  add column if not exists noshow_fee_order_id text;

comment on column bookings.noshow_fee_order_id is
  'Square order id of the customer-facing no-show-fee payment link; reconcile key for marking the fee charged.';

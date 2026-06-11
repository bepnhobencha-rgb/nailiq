-- No-show fee via Square card-on-file (Option C: save card, charge only if no-show).
alter table public.bookings add column if not exists noshow_card_id text;
alter table public.bookings add column if not exists noshow_customer_id text;
alter table public.bookings add column if not exists noshow_fee_cents integer;
alter table public.bookings add column if not exists noshow_charge_status text;
alter table public.bookings add column if not exists noshow_payment_id text;
alter table public.square_integrations add column if not exists application_id text;
alter table public.square_integrations add column if not exists environment text not null default 'production';

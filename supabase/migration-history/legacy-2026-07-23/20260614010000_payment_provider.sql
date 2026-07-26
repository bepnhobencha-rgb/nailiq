-- Per-salon payment provider for customer money flows (no-show card-on-file,
-- deposits). 'square' | 'stripe'; null = not chosen yet. Chosen at salon setup
-- via 1-click OAuth. Resolver falls back to 'square' when square_integrations is
-- connected but this is still null (back-compat for salons already on Square).
alter table public.salons
  add column if not exists payment_provider text
    check (payment_provider in ('square', 'stripe'));

comment on column public.salons.payment_provider is
  'Customer-payment provider: square | stripe (null = not chosen). All money flows (no-show card-on-file, deposits) use this. Lock after the first saved card — provider-specific tokens cannot migrate.';

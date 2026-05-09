-- Extends the existing `client_profiles` table (cross-salon, phone-keyed
-- per the original design in `20260430180000_client_profiles.sql`) with
-- the columns required by the salon Clients panel:
--   - email           — optional contact channel
--   - total_spent_cents — running aggregate (re-derived from bookings on
--                         each load; column kept for future cached writes)
--   - notes           — owner-authored notes about the client
--   - is_vip          — VIP flag toggleable from the panel
--   - updated_at      — bookkeeping; triggered by client-side writes
--
-- Intentionally NOT salon-scoped: `client_profiles.phone` is unique
-- globally and the public booking flow upserts cross-salon. Per-salon
-- VIP / notes (if salons want different policies for the same phone)
-- requires a separate `client_salon_metadata` table — flagged for
-- follow-up; out of scope here.
--
-- RLS untouched: existing wide-open policies remain so the public
-- booking page can still upsert. Owner-only access for notes / VIP is
-- enforced at the server-action layer (`updateClientProfile`).

alter table public.client_profiles
  add column if not exists email text,
  add column if not exists total_spent_cents bigint not null default 0,
  add column if not exists notes text,
  add column if not exists is_vip boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

comment on column public.client_profiles.email is
  'Optional contact email; populated when the booking guest provided one.';
comment on column public.client_profiles.notes is
  'Owner-authored note about the client. Cross-salon by design (table is global, phone-keyed); a per-salon notes split lives in a future client_salon_metadata table.';
comment on column public.client_profiles.is_vip is
  'VIP flag — surfaced as a Badge in the receptionist queue / detail surfaces. Cross-salon (see notes column).';

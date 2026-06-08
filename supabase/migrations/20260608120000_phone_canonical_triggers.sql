-- Canonical customer-phone normalizer enforced at the DB boundary so EVERY
-- write path (booking form, group, voice AI, Wix import, gift card, party
-- claim, quick-rebook, …) stores ONE format: E.164 digits without a leading
-- "+", with a country code (e.g. "17788680738"). This is the safety net that
-- keeps the format consistent even if a code path forgets to normalize.
--
-- Mirrors `toCanonicalPhone()` (src/shared/lib/toCanonicalPhone.ts) on the app
-- side. A one-time data backfill (merge duplicate profiles + reformat existing
-- rows in client_profiles/bookings/party_link_claims/voice_ai_sessions/vouchers)
-- was run against prod alongside this migration.

create or replace function public.canonical_phone(p text)
returns text language plpgsql immutable as $$
declare d text;
begin
  if p is null then return null; end if;
  d := regexp_replace(p, '\D', '', 'g');
  if d = '' then return p; end if;             -- no digits → keep original
  if length(d) = 10 then return '1' || d; end if; -- bare NANP 10-digit
  return d;                                    -- already carries a country code
end; $$;

create or replace function public.tg_canon_phone()
returns trigger language plpgsql as $$
begin NEW.phone := public.canonical_phone(NEW.phone); return NEW; end; $$;

create or replace function public.tg_canon_client_phone()
returns trigger language plpgsql as $$
begin NEW.client_phone := public.canonical_phone(NEW.client_phone); return NEW; end; $$;

create or replace function public.tg_canon_member_phone()
returns trigger language plpgsql as $$
begin NEW.member_phone := public.canonical_phone(NEW.member_phone); return NEW; end; $$;

create or replace function public.tg_canon_voucher_phones()
returns trigger language plpgsql as $$
begin
  NEW.client_phone := public.canonical_phone(NEW.client_phone);
  NEW.gift_card_purchaser_phone := public.canonical_phone(NEW.gift_card_purchaser_phone);
  return NEW;
end; $$;

drop trigger if exists trg_canon_phone on public.client_profiles;
create trigger trg_canon_phone before insert or update of phone
  on public.client_profiles for each row execute function public.tg_canon_phone();

drop trigger if exists trg_canon_client_phone on public.bookings;
create trigger trg_canon_client_phone before insert or update of client_phone
  on public.bookings for each row execute function public.tg_canon_client_phone();

drop trigger if exists trg_canon_member_phone on public.party_link_claims;
create trigger trg_canon_member_phone before insert or update of member_phone
  on public.party_link_claims for each row execute function public.tg_canon_member_phone();

drop trigger if exists trg_canon_client_phone on public.voice_ai_sessions;
create trigger trg_canon_client_phone before insert or update of client_phone
  on public.voice_ai_sessions for each row execute function public.tg_canon_client_phone();

drop trigger if exists trg_canon_client_phone on public.voucher_redemptions;
create trigger trg_canon_client_phone before insert or update of client_phone
  on public.voucher_redemptions for each row execute function public.tg_canon_client_phone();

drop trigger if exists trg_canon_voucher_phones on public.vouchers;
create trigger trg_canon_voucher_phones before insert or update of client_phone, gift_card_purchaser_phone
  on public.vouchers for each row execute function public.tg_canon_voucher_phones();

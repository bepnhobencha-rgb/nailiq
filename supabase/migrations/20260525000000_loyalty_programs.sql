-- loyalty_programs table
CREATE TABLE public.loyalty_programs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id        uuid NOT NULL REFERENCES public.salons(id),
  name            text NOT NULL DEFAULT 'Loyalty Rewards',
  is_active       boolean NOT NULL DEFAULT true,
  stamps_required integer NOT NULL DEFAULT 10 CHECK (stamps_required BETWEEN 3 AND 50),
  reward_type     text NOT NULL DEFAULT 'free_service' CHECK (reward_type IN ('free_service','percent_off','amount_off')),
  reward_service_id uuid REFERENCES public.services(id),
  reward_percent_off smallint CHECK (reward_percent_off BETWEEN 1 AND 100),
  reward_amount_off_cents integer CHECK (reward_amount_off_cents > 0),
  stamps_per_visit integer NOT NULL DEFAULT 1 CHECK (stamps_per_visit BETWEEN 1 AND 5),
  min_spend_cents  integer NOT NULL DEFAULT 0,
  description      text,
  color            text DEFAULT '#D4AF37' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salon_id)
);

-- loyalty_cards table
CREATE TABLE public.loyalty_cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id        uuid NOT NULL REFERENCES public.salons(id),
  program_id      uuid NOT NULL REFERENCES public.loyalty_programs(id),
  client_phone    text NOT NULL,
  client_profile_id uuid REFERENCES public.client_profiles(id),
  stamps_current  integer NOT NULL DEFAULT 0 CHECK (stamps_current >= 0),
  stamps_lifetime integer NOT NULL DEFAULT 0,
  rewards_earned  integer NOT NULL DEFAULT 0,
  rewards_redeemed integer NOT NULL DEFAULT 0,
  last_stamp_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salon_id, client_phone)
);

-- loyalty_stamp_events table
CREATE TABLE public.loyalty_stamp_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id     uuid NOT NULL REFERENCES public.salons(id),
  card_id      uuid NOT NULL REFERENCES public.loyalty_cards(id),
  booking_id   uuid REFERENCES public.bookings(id),
  event_type   text NOT NULL CHECK (event_type IN ('earn','redeem','manual_add','manual_remove','expire')),
  stamps_delta integer NOT NULL,
  stamps_after integer NOT NULL,
  note         text,
  actor_user_id uuid REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_loyalty_cards_salon_phone ON public.loyalty_cards(salon_id, client_phone);
CREATE INDEX idx_loyalty_stamp_events_card ON public.loyalty_stamp_events(card_id, created_at DESC);
CREATE INDEX idx_loyalty_stamp_events_salon ON public.loyalty_stamp_events(salon_id, created_at DESC);

-- RLS
ALTER TABLE public.loyalty_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_stamp_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner manage loyalty_programs"
  ON public.loyalty_programs FOR ALL
  USING (salon_id IN (SELECT salon_id FROM salon_members WHERE user_id = auth.uid()));

CREATE POLICY "owner manage loyalty_cards"
  ON public.loyalty_cards FOR ALL
  USING (salon_id IN (SELECT salon_id FROM salon_members WHERE user_id = auth.uid()));

CREATE POLICY "owner manage loyalty_stamp_events"
  ON public.loyalty_stamp_events FOR ALL
  USING (salon_id IN (SELECT salon_id FROM salon_members WHERE user_id = auth.uid()));

-- Public read loyalty cards (filtered by phone in app layer)
CREATE POLICY "public read own card by phone"
  ON public.loyalty_cards FOR SELECT
  USING (true);

-- Auto-stamp trigger
CREATE OR REPLACE FUNCTION public.auto_stamp_on_booking_complete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_program loyalty_programs%ROWTYPE;
  v_card    loyalty_cards%ROWTYPE;
  v_new_stamps integer;
BEGIN
  IF NEW.status != 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_program
  FROM loyalty_programs
  WHERE salon_id = NEW.salon_id AND is_active = true
  LIMIT 1;

  IF NOT FOUND THEN RETURN NEW; END IF;

  IF NEW.client_phone IS NULL OR trim(NEW.client_phone) = '' THEN
    RETURN NEW;
  END IF;

  IF v_program.min_spend_cents > 0
    AND COALESCE(NEW.price_cents, 0) < v_program.min_spend_cents THEN
    RETURN NEW;
  END IF;

  INSERT INTO loyalty_cards (salon_id, program_id, client_phone)
  VALUES (NEW.salon_id, v_program.id, NEW.client_phone)
  ON CONFLICT (salon_id, client_phone) DO NOTHING;

  SELECT * INTO v_card
  FROM loyalty_cards
  WHERE salon_id = NEW.salon_id AND client_phone = NEW.client_phone;

  v_new_stamps := v_card.stamps_current + v_program.stamps_per_visit;

  IF v_new_stamps >= v_program.stamps_required THEN
    UPDATE loyalty_cards SET
      stamps_current  = 0,
      stamps_lifetime = stamps_lifetime + v_program.stamps_per_visit,
      rewards_earned  = rewards_earned + 1,
      last_stamp_at   = now(),
      updated_at      = now()
    WHERE id = v_card.id;

    INSERT INTO loyalty_stamp_events (
      salon_id, card_id, booking_id, event_type, stamps_delta, stamps_after
    ) VALUES (
      NEW.salon_id, v_card.id, NEW.id, 'earn',
      v_program.stamps_per_visit, 0
    );
  ELSE
    UPDATE loyalty_cards SET
      stamps_current  = v_new_stamps,
      stamps_lifetime = stamps_lifetime + v_program.stamps_per_visit,
      last_stamp_at   = now(),
      updated_at      = now()
    WHERE id = v_card.id;

    INSERT INTO loyalty_stamp_events (
      salon_id, card_id, booking_id, event_type, stamps_delta, stamps_after
    ) VALUES (
      NEW.salon_id, v_card.id, NEW.id, 'earn',
      v_program.stamps_per_visit, v_new_stamps
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_stamp_on_complete
  AFTER UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.auto_stamp_on_booking_complete();

-- updated_at trigger reuse
CREATE TRIGGER trg_loyalty_programs_updated_at
  BEFORE UPDATE ON public.loyalty_programs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_loyalty_cards_updated_at
  BEFORE UPDATE ON public.loyalty_cards
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

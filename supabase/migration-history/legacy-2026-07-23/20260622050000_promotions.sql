-- Promotion campaigns: time-limited discounts that auto-apply (no code needed)
CREATE TABLE promotions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id        uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  -- Optional schedule constraints (NULL = all day / all week)
  days_of_week    int[],   -- 0=Sun..6=Sat; NULL = every day
  time_start      time,    -- Happy Hour start (salon local time)
  time_end        time,    -- Happy Hour end (salon local time)
  -- Discount applied when no per-service rule exists
  discount_type   text NOT NULL CHECK (discount_type IN ('fixed_price','percent','amount')),
  discount_value  int  NOT NULL,  -- cents (fixed_price/amount) or basis points (percent: 2000 = 20%)
  -- 'all' applies to every service; 'specific' only to rows in promotion_services
  applies_to      text NOT NULL DEFAULT 'specific' CHECK (applies_to IN ('all','specific')),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

-- Per-service overrides within a campaign
CREATE TABLE promotion_services (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id    uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  service_id      uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  -- NULL = use parent promotion discount
  discount_type   text CHECK (discount_type IN ('fixed_price','percent','amount')),
  discount_value  int,
  UNIQUE (promotion_id, service_id)
);

-- Track which booking was discounted and the original price
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS promo_id              uuid REFERENCES promotions(id),
  ADD COLUMN IF NOT EXISTS original_price_cents  int;

-- One-time email capture discount (1 per phone profile)
ALTER TABLE client_profiles
  ADD COLUMN IF NOT EXISTS email_discount_claimed_at  timestamptz;

-- Indexes for fast lookups
CREATE INDEX ON promotions(salon_id, starts_at, ends_at) WHERE active = true;
CREATE INDEX ON promotion_services(promotion_id);
CREATE INDEX ON promotion_services(service_id);

-- RLS: salon owners/admins manage their own promotions
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_services ENABLE ROW LEVEL SECURITY;

-- Public read (needed for booking page to fetch active promos)
CREATE POLICY "public_read_active_promotions" ON promotions
  FOR SELECT USING (active = true AND now() BETWEEN starts_at AND ends_at);

CREATE POLICY "public_read_promotion_services" ON promotion_services
  FOR SELECT USING (true);

-- Auth users who are members of the salon can manage
CREATE POLICY "salon_member_manage_promotions" ON promotions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM salon_members sm
      WHERE sm.salon_id = promotions.salon_id
        AND sm.user_id = auth.uid()
        AND sm.role IN ('owner','admin','manager')
    )
  );

CREATE POLICY "salon_member_manage_promotion_services" ON promotion_services
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM promotions p
      JOIN salon_members sm ON sm.salon_id = p.salon_id
      WHERE p.id = promotion_services.promotion_id
        AND sm.user_id = auth.uid()
        AND sm.role IN ('owner','admin','manager')
    )
  );

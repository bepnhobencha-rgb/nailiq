-- P2.8 — Add an owner-editable description column to salons.
--
-- Surfaced on the public booking page as the salon hero tagline, replacing
-- the generic "Curated nail artistry…" fallback. Setup wizard exposes a
-- textarea so owners can write their own positioning copy (multilingual,
-- emoji, etc.) without a developer.
--
-- Column is nullable: existing rows + new salons that skip the field
-- keep the existing tagline copy.

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS description text;

-- Soft length cap matches the UI counter (250 chars). DB cap is generous
-- (`text` has no inherent limit) but a `check` keeps app + DB in sync
-- without a separate validation layer.
ALTER TABLE public.salons
  ADD CONSTRAINT IF NOT EXISTS salons_description_len
  CHECK (description IS NULL OR char_length(description) <= 400);

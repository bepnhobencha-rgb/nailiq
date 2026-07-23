-- Add google_review_url column to salons
-- Used for ≥4★ review redirect and dual-button review emails.
ALTER TABLE public.salons ADD COLUMN IF NOT EXISTS google_review_url TEXT;

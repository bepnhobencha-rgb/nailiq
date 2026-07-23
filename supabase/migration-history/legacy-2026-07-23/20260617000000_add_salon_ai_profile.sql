-- Add AI manager profile column to salons
-- Stores SalonIntelligenceProfile JSON — built via Manager Briefing wizard
-- or auto-derived from existing salon settings (defaultSip fallback).
ALTER TABLE salons
  ADD COLUMN IF NOT EXISTS ai_profile jsonb;

COMMENT ON COLUMN salons.ai_profile IS 'SalonIntelligenceProfile — AI Manager configuration built via Manager Briefing';

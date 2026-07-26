-- Migration: add lang column to client_ai_summaries
-- Tracks which language the cached AI summary was generated in.
-- Allows loadClientProfile360 to invalidate cache when the requested
-- language differs from the cached one, forcing a fresh generation
-- in the correct language.
--
-- Additive — existing rows get default 'vi' (Vietnamese was the only
-- language the generator produced before this change). No data is lost.

alter table public.client_ai_summaries
  add column if not exists lang text not null default 'vi';

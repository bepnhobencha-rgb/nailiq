-- Import jobs track progress of scraping a salon's existing website.
-- Edge Function updates status/progress; frontend subscribes via Realtime.

CREATE TABLE IF NOT EXISTS public.website_import_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id        UUID NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  source_url      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','scraping','extracting','building','done','failed')),
  progress        INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  result          JSONB,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_salon_created
  ON public.website_import_jobs(salon_id, created_at DESC);

ALTER TABLE public.website_import_jobs ENABLE ROW LEVEL SECURITY;

-- Salon members (any role) can read/manage import jobs for their salon.
CREATE POLICY "salon_member_all"
  ON public.website_import_jobs FOR ALL
  USING (
    salon_id IN (
      SELECT salon_id FROM public.salon_members WHERE user_id = auth.uid()
    )
  );

-- Demo cookie path: Edge Function and API route use service role, no RLS needed there.

CREATE OR REPLACE FUNCTION public.update_website_import_jobs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER website_import_jobs_updated_at
  BEFORE UPDATE ON public.website_import_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_website_import_jobs_updated_at();

-- Storage bucket for imported salon assets (logos, hero images, gallery).
-- Public bucket so images are directly linkable in page sections.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'salon-imports',
  'salon-imports',
  true,
  5242880,
  ARRAY['image/jpeg','image/png','image/webp','image/gif']
) ON CONFLICT (id) DO NOTHING;

-- Anyone can read public salon-imports (needed to render public booking pages).
CREATE POLICY "public_read_salon_imports"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'salon-imports');

-- Service role (Edge Function) writes — no extra policy needed (bypasses RLS).

CREATE TABLE public.salon_page_sections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id      UUID NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('hero','services','about','gallery','promotions','contact','blog')),
  title         TEXT NOT NULL DEFAULT '',
  is_visible    BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  content       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_salon_page_sections_salon_id ON public.salon_page_sections(salon_id, sort_order);

ALTER TABLE public.salon_page_sections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "salon_member_rw" ON public.salon_page_sections
  FOR ALL USING (
    salon_id IN (
      SELECT salon_id FROM public.salon_members WHERE user_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION public.update_salon_page_sections_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER salon_page_sections_updated_at
  BEFORE UPDATE ON public.salon_page_sections
  FOR EACH ROW EXECUTE FUNCTION public.update_salon_page_sections_updated_at();

CREATE OR REPLACE FUNCTION public.seed_default_page_sections(p_salon_id UUID)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.salon_page_sections (salon_id, type, title, is_visible, sort_order, content)
  VALUES
    (p_salon_id, 'hero',       'Hero',       true,  0, '{"heading":"Welcome","subheading":"","cta_text":"Book now","bg_image_url":null}'),
    (p_salon_id, 'services',   'Dịch vụ',    true,  1, '{"section_title":"Our services","description":"","show_price":"full","display_count":"all"}'),
    (p_salon_id, 'about',      'About',      true,  2, '{"section_title":"About us","body":"","image_url":null,"layout":"image-left"}'),
    (p_salon_id, 'gallery',    'Gallery',    true,  3, '{"section_title":"Our work","images":[],"grid_style":"3-col"}'),
    (p_salon_id, 'promotions', 'Khuyến mãi', false, 4, '{"section_title":"Special offers","body":"","expires_at":null,"bg_style":"brand"}'),
    (p_salon_id, 'contact',    'Liên hệ',    false, 5, '{"address":"","phone":"","email":"","show_map":true}'),
    (p_salon_id, 'blog',       'Blog',       false, 6, '{"section_title":"Tips & care","post_count":3}')
  ON CONFLICT DO NOTHING;
END;
$$;

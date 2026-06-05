-- Per-tenant custom domains: map an external hostname to a salon so the
-- public booking page can be served on the salon's own domain.
CREATE TABLE IF NOT EXISTS public.salon_custom_domains (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  domain      text NOT NULL,
  verified    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salon_custom_domains_domain_lower_chk CHECK (domain = lower(domain)),
  CONSTRAINT salon_custom_domains_domain_fmt_chk CHECK (domain ~ '^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$')
);

CREATE UNIQUE INDEX IF NOT EXISTS salon_custom_domains_domain_key
  ON public.salon_custom_domains (domain);
CREATE INDEX IF NOT EXISTS salon_custom_domains_salon_id_idx
  ON public.salon_custom_domains (salon_id);

ALTER TABLE public.salon_custom_domains ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS salon_custom_domains_member_all ON public.salon_custom_domains;
CREATE POLICY salon_custom_domains_member_all
  ON public.salon_custom_domains
  FOR ALL
  USING (
    salon_id IN (
      SELECT salon_id FROM public.salon_members WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    salon_id IN (
      SELECT salon_id FROM public.salon_members WHERE user_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION public.public_resolve_domain(p_host text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.slug
  FROM public.salon_custom_domains d
  JOIN public.salons s ON s.id = d.salon_id
  WHERE d.domain = lower(p_host)
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.public_resolve_domain(text) FROM public;
GRANT EXECUTE ON FUNCTION public.public_resolve_domain(text) TO anon, authenticated, service_role;

COMMENT ON TABLE public.salon_custom_domains IS
  'Maps an external hostname to a salon for serving the public booking page on the salon''s own domain. Resolved at the proxy via public_resolve_domain().';

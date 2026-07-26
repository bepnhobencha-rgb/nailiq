-- App-level rate limiting independent of the Vercel WAF (works on any plan).
-- Fixed-window counter, atomic increment + verdict in one SECURITY DEFINER call
-- so there's no read-then-write race across concurrent serverless invocations.
CREATE TABLE IF NOT EXISTS public.rate_limits (
  bucket text PRIMARY KEY,
  count integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expires_idx ON public.rate_limits (expires_at);

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rate_limits FROM anon, authenticated, public;

CREATE OR REPLACE FUNCTION public.rate_limit_hit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_window bigint := floor(extract(epoch FROM clock_timestamp()) / p_window_seconds);
  v_bucket text := p_key || ':' || v_window::text;
  v_count integer;
BEGIN
  INSERT INTO public.rate_limits (bucket, count, expires_at)
  VALUES (v_bucket, 1, to_timestamp((v_window + 2) * p_window_seconds))
  ON CONFLICT (bucket) DO UPDATE SET count = public.rate_limits.count + 1
  RETURNING count INTO v_count;

  DELETE FROM public.rate_limits WHERE expires_at < now() - interval '1 hour';

  RETURN v_count <= p_limit;  -- true = allowed
END;
$$;

REVOKE ALL ON FUNCTION public.rate_limit_hit(text, integer, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(text, integer, integer) TO service_role;

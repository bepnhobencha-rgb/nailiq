-- New functions must be explicitly exposed. This prevents an internal helper
-- from silently becoming a PostgREST RPC for every visitor or signed-in user.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- Supabase owns and manages the separate supabase_admin defaults. Project
-- migrations run as postgres, so changing that platform role is intentionally
-- outside this migration's authority.

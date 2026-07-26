-- PostgreSQL's built-in PUBLIC EXECUTE grant is global. A schema-scoped
-- REVOKE cannot override it, so remove it at the owner level. Explicit grants
-- in individual migrations remain the source of truth for public RPCs.
alter default privileges for role postgres
  revoke execute on functions from public;

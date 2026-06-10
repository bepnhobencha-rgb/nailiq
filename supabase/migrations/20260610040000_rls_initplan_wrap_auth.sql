-- Perf: wrap auth.*() in (select auth.*()) inside every RLS policy so Postgres
-- evaluates the auth function ONCE per query instead of once per row
-- (Supabase "auth_rls_initplan" advisor). Pure performance — a stable scalar
-- subquery returns the same value, so policy logic is unchanged.
-- Applied to prod 2026-06-10 via MCP; this file keeps fresh DBs in sync.
-- Idempotent: the WHERE guard skips policies already wrapped (case-insensitive).
DO $$
DECLARE r record; stmt text;
BEGIN
  FOR r IN
    SELECT policyname, tablename, qual, with_check
    FROM pg_policies
    WHERE schemaname='public'
      AND ((qual ~* 'auth\.(uid|role|jwt|email)\(\)' AND qual !~* '\(\s*select\s+auth\.')
        OR (with_check ~* 'auth\.(uid|role|jwt|email)\(\)' AND with_check !~* '\(\s*select\s+auth\.'))
  LOOP
    stmt := 'ALTER POLICY ' || quote_ident(r.policyname) || ' ON public.' || quote_ident(r.tablename);
    IF r.qual IS NOT NULL THEN
      stmt := stmt || ' USING (' || regexp_replace(regexp_replace(regexp_replace(regexp_replace(r.qual,
        'auth\.uid\(\)','( SELECT auth.uid() )','g'),'auth\.role\(\)','( SELECT auth.role() )','g'),
        'auth\.jwt\(\)','( SELECT auth.jwt() )','g'),'auth\.email\(\)','( SELECT auth.email() )','g') || ')';
    END IF;
    IF r.with_check IS NOT NULL THEN
      stmt := stmt || ' WITH CHECK (' || regexp_replace(regexp_replace(regexp_replace(regexp_replace(r.with_check,
        'auth\.uid\(\)','( SELECT auth.uid() )','g'),'auth\.role\(\)','( SELECT auth.role() )','g'),
        'auth\.jwt\(\)','( SELECT auth.jwt() )','g'),'auth\.email\(\)','( SELECT auth.email() )','g') || ')';
    END IF;
    EXECUTE stmt;
  END LOOP;
END $$;

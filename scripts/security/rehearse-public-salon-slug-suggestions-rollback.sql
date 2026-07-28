\set ON_ERROR_STOP on

BEGIN;

DROP FUNCTION public.suggest_salon_slugs_by_similarity(text);

DO $rollback_proof$
BEGIN
  IF to_regprocedure(
    'public.suggest_salon_slugs_by_similarity(text)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'rollback left salon slug suggestions installed';
  END IF;
END
$rollback_proof$;

ROLLBACK;

\ir check-public-salon-slug-suggestions.sql

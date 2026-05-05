-- B-06 follow-up: tighten client_name / client_profiles.name CHECK constraints
-- to block a broader set of injection-prone chars (was just `<>`, now `<>{}=&;`).
-- Pairs with src/shared/lib/nameFormat.ts SAFE_NAME_REGEX as defense-in-depth:
-- if a future code path forgets to call isValidCustomerName, the DB still rejects.
--
-- Data cleanup has already run (B-06 cleanup SQL replaced dirty rows with
-- '[removed]'), so these constraints are added with full validation — no
-- NOT VALID escape hatch.

-- bookings: drop the older, narrower constraint and replace with stricter version.
ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_client_name_safe;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_client_name_safe_check CHECK (
    client_name IS NULL
    OR (
      length(client_name) BETWEEN 1 AND 100
      AND client_name !~ '[<>{}=&;]'
    )
  );

-- client_profiles: new constraint (no prior protection on this column).
ALTER TABLE public.client_profiles
  ADD CONSTRAINT client_profiles_name_safe_check CHECK (
    name IS NULL
    OR (
      length(name) BETWEEN 1 AND 100
      AND name !~ '[<>{}=&;]'
    )
  );

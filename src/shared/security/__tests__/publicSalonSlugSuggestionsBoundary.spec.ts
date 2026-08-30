import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

const migration = read(
  "supabase/migrations/20260728180000_restore_public_salon_slug_suggestions.sql",
);
const proof = read(
  "scripts/security/check-public-salon-slug-suggestions.sql",
);
const rollback = read(
  "scripts/security/rehearse-public-salon-slug-suggestions-rollback.sql",
);
const parity = read("scripts/check-schema-parity.ts");
const route = read("src/app/api/public/salon-suggestions/route.ts");
const notFound = read("src/app/not-found.tsx");
const suggestions = read(
  "src/components/booking/SalonSlugSuggestions.tsx",
);

describe("public salon slug suggestion boundary", () => {
  it("queries only the booking-safe salon profile surface", () => {
    expect(migration).toContain("SECURITY INVOKER");
    expect(migration).toContain("public.public_salon_profiles");
    expect(migration).not.toMatch(/FROM public\.salons/i);
    expect(migration).toContain(
      "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions",
    );
    expect(migration).toContain("extension.extname = 'pg_trgm'");
    expect(migration).toContain("%1$I.similarity(");
    expect(migration).toContain("LIMIT 3");
  });

  it("exposes the read-only RPC through explicit public role grants", () => {
    expect(migration).toContain(
      "FROM PUBLIC, anon, authenticated",
    );
    expect(migration).toContain(
      "TO anon, service_role",
    );
    expect(migration).toContain(
      "has_function_privilege('authenticated', v_oid, 'EXECUTE')",
    );
    expect(migration).toContain("grantee = 0");
    expect(migration).toContain("privilege_type = 'EXECUTE'");
    expect(proof).toContain("public.public_salon_profiles");
    expect(proof).toContain("grantee = 0");
    expect(parity).toContain("functions: 419");
    expect(parity).toContain('"suggest_salon_slugs_by_similarity"');
  });

  it("rehearses removal without changing the verified final state", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain(
      "DROP FUNCTION public.suggest_salon_slugs_by_similarity(text)",
    );
    expect(rollback).toContain("ROLLBACK;");
    expect(rollback).toContain("\\ir check-public-salon-slug-suggestions.sql");
  });

  it("validates requests and preserves a static global 404 shell", () => {
    expect(route).toContain("validatePublicBookingSlug(slug)");
    expect(route).toContain(".slice(0, 3)");
    expect(route).toContain('"Cache-Control"');
    expect(notFound).toContain("<SalonSlugSuggestions />");
    expect(suggestions).toContain("usePathname()");
    expect(suggestions).toContain("segment.length === 1");
    expect(suggestions).toContain("BOOKING_SLUG.test(segment[0])");
    expect(suggestions).toContain("Did you mean?");
  });
});

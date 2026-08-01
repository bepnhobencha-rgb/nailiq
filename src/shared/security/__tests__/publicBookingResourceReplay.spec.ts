import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260801122337_ensure_public_booking_resource_autoassign_replay.sql",
  ),
  "utf8",
);
const receptionist = readFileSync(
  resolve(process.cwd(), "src/shared/dashboard/receptionistActions.ts"),
  "utf8",
);

describe("public booking resource replay parity", () => {
  it("repairs only clean replays missing the private 14-argument implementation", () => {
    expect(migration).toContain(
      "IF to_regprocedure(\n    'public.create_public_booking_unlimited_14",
    );
    expect(migration).toContain("IS NULL THEN");
    expect(migration).toContain(
      "CREATE FUNCTION public.create_public_booking_unlimited_14",
    );
    expect(migration).toContain("create_public_booking v2.9");
    expect(migration).toContain("v_resource_id := p_resource_id");
    expect(migration).toContain(
      "DROP FUNCTION IF EXISTS public.create_public_booking_unlimited_13",
    );
  });

  it("keeps the private implementation inaccessible to browser roles", () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.create_public_booking_unlimited_14[\s\S]*FROM PUBLIC, anon, authenticated/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.create_public_booking_unlimited_14[\s\S]*TO service_role/,
    );
  });

  it("passes the desk-selected resource through the atomic booking RPC", () => {
    expect(receptionist).toContain("p_resource_id: resolvedResourceId");
    expect(receptionist).not.toContain(
      "resource link is cosmetic",
    );
  });
});

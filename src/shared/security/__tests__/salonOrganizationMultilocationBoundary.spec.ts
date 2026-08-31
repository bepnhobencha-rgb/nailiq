import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260822155809_add_salon_organization_multilocation.sql",
);
const rehearsal = read(
  "scripts/security/rehearse-salon-organization-multilocation.sql",
);
const concurrency = read(
  "scripts/security/rehearse-salon-organization-multilocation-concurrency.mjs",
);

describe("salon organization multi-location boundary", () => {
  it("keeps organization sharing explicit and one-organization-per-salon", () => {
    expect(migration).toContain("UNIQUE (salon_id)");
    expect(migration).toContain(
      "an organization requires at least two distinct salons",
    );
    expect(migration).toContain(
      "owner access is required for every organization salon",
    );
    expect(migration).not.toContain("FROM public.salons AS auto_link");
  });

  it("requires consent before a global client identity can be shared", () => {
    expect(migration).toContain("organization_client_consents");
    expect(migration).toContain("occ.revoked_at IS NULL");
    expect(migration).toContain(
      "active organization sharing consent required",
    );
    expect(rehearsal).toContain("v_client.location_count <> 2");
    expect(rehearsal).toContain("v_client.total_spent_cents <> 3000");
  });

  it("serializes shared staff capacity across both scheduling models", () => {
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("FROM public.bookings AS b");
    expect(migration).toContain("FROM public.booking_service_segments AS seg");
    expect(migration).toContain(
      "organization staff is already booked at another location",
    );
    expect(concurrency).toContain("Promise.allSettled");
    expect(concurrency).toContain(
      'staffRace.filter((result) => result.status === "fulfilled").length, 1',
    );
  });

  it("makes shared loyalty atomic, idempotent and branch-attributed", () => {
    expect(migration).toContain("loyalty earn requires a completed booking");
    expect(migration).toContain(
      "loyalty redemption must consume one configured reward",
    );
    expect(migration).toContain("loyalty idempotency payload mismatch");
    expect(migration).toContain("FOR UPDATE");
    expect(concurrency).toContain("sameKeyRace");
    expect(concurrency).toContain('assert.deepEqual(sameKeyRace.sort()');
  });

  it("separates branch reports and denies cross-organization access", () => {
    expect(migration).toContain("'branch'::text");
    expect(migration).toContain("'organization'::text");
    expect(migration).toContain("organization access denied");
    expect(rehearsal).toContain("owner read reporting from another organization");
    expect(rehearsal).toContain("owner read customer profiles from another organization");
  });

  it("uses forced RLS and explicit least-privilege grants", () => {
    expect(migration.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(9);
    expect(migration).toContain(
      "REVOKE ALL ON TABLE public.organization_client_consents",
    );
    expect(migration).toContain(
      "GRANT SELECT ON TABLE public.organization_client_consents TO authenticated",
    );
    expect(migration).toContain(
      "GRANT ALL ON TABLE public.organization_client_consents TO service_role",
    );
    expect(rehearsal).toContain("anon can select %");
  });

  it("updates the full candidate schema parity tripwire", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("tables: 200");
    expect(parity).toContain("columns: 3049");
    expect(parity).toContain("policies: 213");
    expect(parity).toContain("functions: 444");
    expect(parity).toContain("triggers: 105");
    expect(parity).toContain("indexes: 756");
    expect(parity).toContain(
      "const GRANTS = { anon: 56, authenticated: 78, service_role: 188 }",
    );
  });
});

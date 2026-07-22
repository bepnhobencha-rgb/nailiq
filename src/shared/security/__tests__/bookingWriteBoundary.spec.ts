import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("public booking write boundary", () => {
  it("keeps anonymous direct booking inserts revoked and fail-closed", () => {
    const dir = resolve(process.cwd(), "supabase/migrations");
    const migrations = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => readFileSync(resolve(dir, name), "utf8"));
    const latestPolicy = migrations
      .filter((sql) => /(?:CREATE|create) POLICY bookings_insert_anon/.test(sql))
      .at(-1);

    expect(latestPolicy).toBeDefined();
    expect(latestPolicy).toMatch(/REVOKE INSERT ON TABLE public\.bookings FROM anon/i);
    expect(latestPolicy).toMatch(/WITH CHECK \(false\)/i);
  });

  it("keeps anonymous group bookings behind validation and abuse controls", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "supabase/migrations/20260722201500_harden_public_group_booking.sql",
      ),
      "utf8",
    );

    expect(migration).toMatch(/RENAME TO insert_group_bookings_unlimited/i);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.insert_group_bookings_unlimited\(jsonb\)/i);
    expect(migration).toMatch(/s\.id = v_service_id AND s\.salon_id = v_salon_id/i);
    expect(migration).toMatch(/st\.id = v_staff_id AND st\.salon_id = v_salon_id/i);
    expect(migration).toMatch(/jsonb_build_object\('price_cents', v_price\)/i);
    expect(migration).toMatch(/public-group-booking:salon:/i);
    expect(migration).toMatch(/public-group-booking:phone:/i);
  });
});

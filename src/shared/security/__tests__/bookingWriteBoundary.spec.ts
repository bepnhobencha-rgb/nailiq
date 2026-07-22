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
});

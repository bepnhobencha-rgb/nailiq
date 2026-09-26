import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReleaseSchemaContract } from "./releaseSchemaContract";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/20260926064325_group_slot_replacement_capabilities.sql");
const parity = read("scripts/check-schema-parity.ts");
const tables = ["group_slot_replacements", "group_slot_replacement_revocations"] as const;

describe("group recovery least-privilege release boundary", () => {
  it.each(tables)("keeps %s private and permits service reads only", (table) => {
    expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
    expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;`);
    expect(migration).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC,anon,authenticated,service_role;`);
    const grants = migration.match(new RegExp(`GRANT\\s+[^;]+\\s+ON\\s+(?:TABLE\\s+)?public\\.${table}\\s+TO\\s+[^;]+;`, "gi"));
    expect(grants).toEqual([`GRANT SELECT ON public.${table} TO service_role;`]);
  });

  it("requires the live parity check to inspect both ledgers and their exact grants", () => {
    assertReleaseSchemaContract(parity);
    const tableManifest = parity.match(/const GROUP_RECOVERY_SERVICE_READ_TABLES = \[([\s\S]*?)\] as const;/)?.[1];
    expect(tableManifest?.match(/"[^"]+"/g)).toEqual(tables.map((table) => `"${table}"`));
    expect(parity).toContain("for (const table of [...CARD_RECOVERY_SERVICE_READ_TABLES, ...GROUP_RECOVERY_SERVICE_READ_TABLES])");
    expect(parity).toContain("grantee in ('PUBLIC', 'anon', 'authenticated')");
    expect(parity).toContain('browserReachable === 0 && serviceGrants === "SELECT"');
    expect(parity).toContain("serviceColumnWrites === 0 && rls === 1 && (!requiresForcedRls || forcedRls === 1)");
    expect(parity).toContain("GROUP_RECOVERY_SERVICE_READ_TABLES.some((name) => name === table)");
  });
});

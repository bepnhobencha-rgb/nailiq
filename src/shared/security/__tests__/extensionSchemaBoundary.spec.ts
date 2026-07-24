import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260724030000_move_btree_gist_to_extensions.sql",
  ),
  "utf8",
);

const rollback = readFileSync(
  resolve(
    process.cwd(),
    "scripts/security/rehearse-btree-gist-extension-rollback.sql",
  ),
  "utf8",
);

describe("extension schema boundary", () => {
  it("moves only the relocatable btree_gist extension out of public", () => {
    expect(migration).toMatch(/e\.extname = 'btree_gist'/i);
    expect(migration).toMatch(/IF NOT v_relocatable THEN/i);
    expect(migration).toMatch(
      /ALTER EXTENSION btree_gist SET SCHEMA extensions/i,
    );
    expect(migration).not.toMatch(/ALTER EXTENSION pg_net/i);
  });

  it("proves both booking exclusion constraints remain valid", () => {
    for (const constraint of [
      "bookings_no_overlap",
      "bookings_resource_no_overlap",
    ]) {
      expect(migration).toContain(constraint);
      expect(rollback).toContain(constraint);
    }
    expect(migration).toMatch(/c\.convalidated/i);
    expect(rollback).toMatch(/c\.convalidated/i);
  });

  it("keeps an exact, transaction-scoped rollback rehearsal", () => {
    expect(rollback).toMatch(/BEGIN;/i);
    expect(rollback).toMatch(/ALTER EXTENSION btree_gist SET SCHEMA public/i);
    expect(rollback).toMatch(/ROLLBACK;/i);
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260803220730_add_durable_ai_execution_limits.sql",
  ),
  "utf8",
);

describe("durable AI execution limit boundary", () => {
  it("is service-role-only and uses an atomic transaction lock", () => {
    expect(migration).toContain("alter table public.ai_execution_limits enable row level security");
    expect(migration).toContain("revoke all on table public.ai_execution_limits from anon, authenticated");
    expect(migration).toContain("security invoker");
    expect(migration).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(migration).toContain("grant execute on function public.claim_ai_execution_slot");
  });

  it("validates bounded inputs and fails duplicate active claims closed", () => {
    expect(migration).toContain("p_window_seconds not between 60 and 2678400");
    expect(migration).toContain("p_max_calls not between 1 and 1000");
    expect(migration).toContain("and expires_at > v_now");
    expect(migration).toContain("return false;");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260731100828_no_show_candidate_confirmation.sql",
  ),
  "utf8",
);

const schedulerBody = migration.slice(
  migration.indexOf("create or replace function public.auto_mark_no_shows()"),
);

describe("automatic no-show review boundary", () => {
  it("persists an idempotent candidate flag without changing attendance or history", () => {
    expect(schedulerBody).toContain("set no_show_candidate_at = now()");
    expect(schedulerBody).toContain("b.no_show_candidate_at is null");
    expect(schedulerBody).toContain("b.status = 'confirmed'");
    expect(schedulerBody).not.toMatch(/set\s+status\s*=/i);
    expect(schedulerBody).not.toContain("client_profiles");
    expect(schedulerBody).not.toContain("no_show_count");
  });

  it("keeps the privileged scheduler closed to browser roles", () => {
    expect(schedulerBody).toContain("set search_path = ''");
    expect(schedulerBody).toContain(
      "revoke all on function public.auto_mark_no_shows() from public",
    );
    expect(schedulerBody).toContain(
      "grant execute on function public.auto_mark_no_shows() to service_role",
    );
  });
});

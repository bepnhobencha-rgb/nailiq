import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260729205808_protect_source_owned_exception_resolution.sql",
);
const inbox = read("src/components/dashboard/OperationalExceptionInbox.tsx");

describe("source-owned operational exception boundary", () => {
  it("rejects manual resolve and reopen for machine-signaled sources", () => {
    expect(migration).toContain(
      "v_alert.source_type in ('ai_execution', 'ai_manager', 'readiness')",
    );
    expect(migration).toContain(
      "p_operation in ('resolve', 'reopen')",
    );
    expect(migration).toContain(
      "return query select 'invalid_state'::text, v_alert.status",
    );
  });

  it("keeps the replacement RPC invoker-scoped and service-role-only", () => {
    expect(migration).toContain("security invoker");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain(
      "revoke all on function public.control_watchdog_alert",
    );
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
    expect(migration).not.toContain("security definer");
  });

  it("does not offer manual resolve or reopen for source-owned rows", () => {
    expect(inbox).toContain(
      "isSourceOwnedOperationalException",
    );
    expect(inbox).toContain(
      'item.status !== "resolved" && !sourceOwned',
    );
    expect(inbox).toContain(
      'item.status === "resolved" && !sourceOwned',
    );
  });
});

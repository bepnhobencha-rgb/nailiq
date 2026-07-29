import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const deliveryMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260729095000_record_digest_delivery_truth.sql",
  ),
  "utf8",
);
const grantMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260729100000_restrict_ai_digest_delivery_grants.sql",
  ),
  "utf8",
);
const migration = `${deliveryMigration}\n${grantMigration}`;

describe("AI digest delivery boundary", () => {
  it("keeps provider acknowledgements service-role-only", () => {
    expect(migration).toContain(
      "alter table public.ai_digest_deliveries enable row level security",
    );
    expect(migration).toMatch(
      /revoke all on table public\.ai_digest_deliveries\s+from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /revoke all on table public\.ai_digest_deliveries from service_role/,
    );
    expect(migration).toMatch(
      /grant select, insert on table public\.ai_digest_deliveries to service_role/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.record_ai_digest_delivery\([\s\S]*?\) from public, anon, authenticated/,
    );
  });

  it("deduplicates a salon day and records the digest audit atomically", () => {
    expect(migration).toContain("unique (salon_id, digest_date)");
    expect(migration).toContain(
      "on conflict (salon_id, digest_date) do update",
    );
    expect(migration).toContain("update public.approval_requests");
    expect(migration).toContain("insert into public.ai_actions_log");
    expect(migration).toContain("target_id = v_delivery_id");
  });

  it("rejects cross-salon approval acknowledgement", () => {
    expect(migration).toContain("and ar.salon_id = p_salon_id");
    expect(migration).toContain("digest_approval_scope_mismatch");
    expect(migration).toContain("and ar.urgency = 'normal'");
  });

  it("adds no campaign, payment, booking, or authentication authority", () => {
    expect(migration).not.toMatch(
      /sendSms|sendEmail|charge|refund|update public\.bookings|auth\./,
    );
  });
});

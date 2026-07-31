import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260731184500_marketing_audience_candidates.sql",
);
const preparation = read("src/shared/ai/audiencePreparation.ts");
const winbackAgent = read("src/shared/winback/agentWinback.ts");

describe("marketing audience boundary", () => {
  it("builds AI execution audiences from the channel-aware segment", () => {
    expect(preparation).toContain('"marketing_audience_candidates" as never');
    expect(preparation).not.toContain('"winback_candidates" as never');
  });

  it("leaves the Kéo Về agent on its original SMS-gated segment", () => {
    // Widening the shared RPC would have changed who that agent contacts.
    // The new function is additive precisely so this caller is untouched.
    expect(winbackAgent).toContain("winback_candidates");
    expect(migration).not.toMatch(
      /(create|alter|drop|revoke|grant)[\s\S]{0,80}?function public\.winback_candidates/i,
    );
  });

  it("accepts consent from either channel, including structured preferences", () => {
    expect(migration).toContain("cp3.marketing_consent_at is not null");
    expect(migration).toContain("cp3.marketing_email_consent_at is not null");
    expect(migration).toContain("pref.consent_marketing_email is true");
    expect(migration).toContain("pref.salon_id = p_salon_id");
  });

  it("keeps the segment salon-scoped and bounded", () => {
    expect(migration).toContain("where svh.salon_id = p_salon_id");
    expect(migration).toContain("limit p_limit");
    expect(migration).toContain("c.visits >= p_min_visits");
  });

  it("never exposes a customer segment to a browser-reachable role", () => {
    expect(migration).toContain(
      "revoke all on function public.marketing_audience_candidates(uuid, integer, integer, integer, integer)\n  from public, anon, authenticated",
    );
    expect(migration).toContain(
      "grant execute on function public.marketing_audience_candidates(uuid, integer, integer, integer, integer)\n  to service_role",
    );
    expect(migration).toContain("set search_path to 'public', 'pg_catalog'");
  });

  it("still re-checks per-recipient consent before anyone is messaged", () => {
    expect(preparation).toContain("decideAudienceEligibility");
    expect(preparation).toContain("marketing_email_consent_at");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260829183626_add_multi_service_controlled_rollout.sql",
  ),
  "utf8",
);

describe("multi-service controlled rollout boundary", () => {
  it("lands default-off and refuses ambiguous pre-existing rollout state", () => {
    expect(migration).toContain("feature_multi_service_booking' AND p.enabled IS TRUE");
    expect(migration).toContain("multi_service_booking_qa_salon_id IS NOT NULL");
    expect(migration).not.toMatch(
      /UPDATE public\.platform_flags[\s\S]*enabled\s*=\s*true/i,
    );
    expect(migration).not.toMatch(
      /INSERT INTO public\.multi_service_booking_rollouts[\s\S]*VALUES\s*\([^;]*true/i,
    );
  });

  it("keeps rollout authorization private and RPC-only", () => {
    expect(migration).toContain(
      "ALTER TABLE public.multi_service_booking_rollouts FORCE ROW LEVEL SECURITY",
    );
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.multi_service_booking_rollouts[\s\S]*FROM PUBLIC, anon, authenticated, service_role/i,
    );
    expect(migration).toContain("AS RESTRICTIVE");
    expect(migration).toContain("USING (false)");
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.configure_multi_service_booking_rollout\([\s\S]*TO service_role/i,
    );
  });

  it("requires exact confirmation, actor, active subscription, and full readiness", () => {
    expect(migration).toContain("ENABLE_MULTI_SERVICE_PRODUCTION");
    expect(migration).toContain("DISABLE_MULTI_SERVICE_PRODUCTION");
    expect(migration).toContain("p_actor_user_id IS NULL");
    expect(migration).toContain("subscription_status NOT IN ('active', 'trialing')");
    expect(migration).toContain("nailiq.multi_service_rollout_salon_id");
    expect(migration).toContain(
      "public.load_public_booking_sequence_readiness(p_salon_id)",
    );
    expect(migration).toContain("SQLSTATE 'NQ002'");
  });

  it("preserves legacy QA while patching both resolver guards fail-closed", () => {
    expect(migration).toContain("multi_service_booking_qa_salon_id = p_salon_id");
    expect(migration).toContain(
      "booking sequence resolver initial authorization guard drifted",
    );
    expect(migration).toContain(
      "booking sequence resolver locked authorization guard drifted",
    );
    expect(migration).toContain(
      "booking sequence readiness authorization guard drifted",
    );
  });

  it("does not change catalog, policy, money, or notification data", () => {
    for (const forbidden of [
      /UPDATE public\.services/i,
      /UPDATE public\.staff_services/i,
      /UPDATE public\.square_integrations/i,
      /cancellation_policy\s*=/i,
      /deposit_enabled\s*=/i,
      /chargeCard|paymentIntents|createDeposit/i,
      /twilio|resend|notification_outbox/i,
    ]) {
      expect(migration).not.toMatch(forbidden);
    }
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260903065331_add_turniq_controlled_shadow_activation.sql",
  ),
  "utf8",
);
const rollbackHardening = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260903065811_harden_turniq_shadow_rollback_availability.sql",
  ),
  "utf8",
);

describe("TurnIQ controlled SHADOW activation boundary", () => {
  it("is inert by default and cannot enable a salon during migration", () => {
    expect(migration).toContain("Empty by default");
    expect(migration).not.toMatch(
      /INSERT INTO public\.turniq_shadow_pilot_allowlist\s*\([^)]*\)\s*VALUES/i,
    );
    expect(migration).not.toMatch(
      /UPDATE public\.salons[\s\S]*?WHERE\s+(?:public\.)?salons\.slug\s*=/i,
    );
    expect(migration).not.toMatch(/hilite|head spa|studio/i);
  });

  it("requires an exact expiring allowlist and salon owner/admin attribution", () => {
    expect(migration).toContain("turniq_shadow_pilot_allowlist");
    expect(migration).toContain(
      "v_allowlist.expected_slug IS DISTINCT FROM v_salon.slug",
    );
    expect(migration).toContain(
      "v_allowlist.expires_at <= pg_catalog.transaction_timestamp()",
    );
    expect(migration).toContain("v_allowlist.revoked_at IS NOT NULL");
    expect(migration).toMatch(
      /m\.user_id = p_actor_user_id[\s\S]*m\.role = p_actor_role[\s\S]*m\.role IN \('owner', 'admin'\)/,
    );
  });

  it("keeps fail-safe rollback available after allowlist expiry or revocation", () => {
    expect(migration).toMatch(
      /IF p_action = 'activate' AND \([\s\S]*v_allowlist\.expires_at <=/,
    );
    expect(migration).toContain(
      "fail-safe rollback remains available after allowlist expiry/revocation",
    );
    expect(rollbackHardening).toContain(
      "p_action = 'activate' AND (",
    );
    expect(rollbackHardening).toContain(
      "REVOKE ALL ON FUNCTION public.configure_turniq_controlled_shadow_pilot_v1",
    );
  });

  it("fails closed on staffing, services, shifts, resources and concurrent pilots", () => {
    expect(migration).toContain("v_active_staff_count < 3");
    expect(migration).toContain("v_active_service_count < 1");
    expect(migration).toContain("v_unqualified_staff_count > 0");
    expect(migration).toContain("v_uncovered_service_count > 0");
    expect(migration).toContain("v_unscheduled_staff_count > 0");
    expect(migration).toContain(
      "v_salon.resources_enabled AND v_active_resource_count < 1",
    );
    expect(migration).toContain("v_missing_resource_kind_count > 0");
    expect(migration).toContain("v_other_non_off_pilot_count > 0");
    expect(migration).toContain("'code', 'readiness_failed'");
  });

  it("only permits service-role with exact confirmations and idempotency", () => {
    expect(migration).toContain("v_role <> 'service_role'");
    expect(migration).toContain("ACTIVATE_TURNIQ_SHADOW_PILOT");
    expect(migration).toContain("ROLLBACK_TURNIQ_SHADOW_PILOT");
    expect(migration).toContain("idempotency_conflict");
    expect(migration).toContain("request_fingerprint ~ '^[0-9a-f]{64}$'");
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.configure_turniq_controlled_shadow_pilot_v1\([\s\S]*FROM PUBLIC, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.configure_turniq_controlled_shadow_pilot_v1\([\s\S]*TO service_role/i,
    );
  });

  it("uses the authoritative stage state machine and limits this boundary to SHADOW/OFF", () => {
    expect(migration).toContain("public.configure_turniq_rollout_stage_v1(");
    expect(migration).toContain("'SET_TURNIQ_STAGE_SHADOW'");
    expect(migration).toContain("'SET_TURNIQ_STAGE_OFF'");
    expect(migration).not.toContain("'SET_TURNIQ_STAGE_SUPERVISED'");
    expect(migration).not.toContain("'SET_TURNIQ_STAGE_LIVE'");
    expect(migration).toContain("rollback_requires_shadow_or_off");
  });

  it("creates an immutable next-business-day policy and activation receipt", () => {
    expect(migration).toContain("INSERT INTO public.turniq_policy_versions");
    expect(migration).toContain("::date + 1");
    expect(migration).toContain("fairness_band_cents");
    expect(migration).toContain("2000");
    expect(migration).toContain("median_eligible_team_credit_at_checkin");
    expect(migration).toContain("turniq_shadow_activation_receipts");
    expect(migration).toContain("UNIQUE (salon_id, command_id)");
    expect(migration).toContain("readiness_snapshot");
    expect(migration).toContain(
      "BEFORE UPDATE OR DELETE ON public.turniq_shadow_activation_receipts",
    );
  });

  it("keeps browser roles out and contains no provider, booking or notification dispatch", () => {
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.turniq_shadow_pilot_allowlist[\s\S]*FROM PUBLIC, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.turniq_shadow_activation_receipts[\s\S]*FROM PUBLIC, anon, authenticated, service_role/i,
    );
    expect(migration).not.toMatch(
      /INSERT INTO public\.(?:bookings|notification_outbox|payment_attempts)/i,
    );
    expect(migration).not.toMatch(/twilio|resend|square|stripe/i);
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260903231500_add_turniq_staff_pin_checkin.sql",
  ),
  "utf8",
);
const indexHotfix = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260904050742_add_turniq_staff_pin_command_receipt_fk_index.sql",
  ),
  "utf8",
);

describe("TurnIQ staff PIN security boundary", () => {
  it("stores only a slow password hash and never a plaintext PIN", () => {
    expect(migration).toContain("pin_hash text NOT NULL");
    expect(migration).toContain("extensions.crypt(p_pin, extensions.gen_salt('bf', 12))");
    expect(migration).toContain("extensions.crypt(p_pin, v_credential.pin_hash)");
    expect(migration).not.toMatch(
      /pin_plain|plaintext_pin|INSERT[^;]+\bp_pin\b[^;]+staff_pin_configuration_receipts/i,
    );
  });

  it("enforces a bounded five-attempt, ten-minute lockout", () => {
    expect(migration).toContain("CHECK (failed_attempts BETWEEN 0 AND 5)");
    expect(migration).toContain("LEAST(");
    expect(migration).toContain("interval '10 minutes'");
    expect(migration).toContain("'code', 'pin_locked'");
  });

  it("keeps credential and receipt tables private with forced RLS", () => {
    for (const table of [
      "turniq_staff_pin_credentials",
      "turniq_staff_pin_configuration_receipts",
      "turniq_staff_pin_shift_receipts",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE public\\.${table}\\s+FORCE ROW LEVEL SECURITY`,
        ),
      );
    }
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.turniq_staff_pin_credentials\s+FROM PUBLIC, anon, authenticated, service_role/,
    );
    expect(migration).not.toMatch(/GRANT[^;]*TO anon|GRANT[^;]*TO authenticated/i);
    expect(migration).not.toContain("SECURITY DEFINER");
  });

  it("allows PIN setup only for an exact Owner/Admin membership", () => {
    expect(migration).toContain("p_actor_role NOT IN ('owner', 'admin')");
    expect(migration).toContain("m.user_id = p_actor_user_id");
    expect(migration).toContain("m.role = p_actor_role");
    expect(migration).toContain("st.status = 'active'");
    expect(migration).toContain("st.deleted_at IS NULL");
  });

  it("wraps the existing atomic shift command and records both identities", () => {
    expect(migration).toContain("public.apply_turniq_shift_command_v1(");
    expect(migration).toContain("session_actor_user_id");
    expect(migration).toContain("staff_id uuid NOT NULL");
    expect(migration).toContain("request_fingerprint");
    expect(migration).toContain("reject_turniq_staff_pin_shift_receipt_mutation");
    expect(migration).toContain("SELECT pr.* INTO v_prior");
    expect(migration).toContain("SELECT cr.result INTO STRICT v_prior_result");
    expect(migration).not.toContain(
      "SELECT pr, cr.result INTO v_prior, v_prior_result",
    );
  });

  it("keeps browser roles from invoking either PIN RPC directly", () => {
    for (const fn of [
      "configure_turniq_staff_pin_v1",
      "apply_turniq_staff_pin_shift_command_v1",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${fn}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated`,
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${fn}\\([\\s\\S]*?TO service_role`,
        ),
      );
    }
  });

  it("does not enable a salon or call payment and messaging providers", () => {
    expect(migration).not.toMatch(/UPDATE public\.salons|INSERT INTO public\.salons/i);
    expect(migration).not.toMatch(/twilio|resend|square|stripe|notification_outbox/i);
  });

  it("covers the composite command-receipt foreign key", () => {
    expect(indexHotfix).toContain(
      "ON public.turniq_staff_pin_shift_receipts (salon_id, command_id)",
    );
    expect(indexHotfix).not.toMatch(
      /UPDATE public\.salons|INSERT INTO public\.salons/i,
    );
  });
});

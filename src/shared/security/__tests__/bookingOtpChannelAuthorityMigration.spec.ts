import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260913034721_scope_booking_otp_channel_authority.sql"), "utf8");
const sqlProof = readFileSync(resolve(process.cwd(), "supabase/tests/booking_otp_channel_authority.sql"), "utf8");

describe("booking OTP proof migration release boundary", () => {
  it("does not promote historical evidence or profile associations into proof", () => {
    expect(migration).toContain("ADD COLUMN verified_channel text NOT NULL DEFAULT 'legacy_unverified'");
    expect(migration).toContain("verified_channel IN ('sms', 'email', 'staff_attested', 'demo', 'legacy_unverified')");
    expect(migration).not.toMatch(/UPDATE\s+(?:public\.)?phone_otp_sessions\s+SET\s+verified_channel/i);
    expect(migration).not.toMatch(/(?:ALTER|DROP)\s+TABLE\s+public\.client_profiles/i);
  });

  it("patches only the known atomic-create guards and leaves replay definitions alone", () => {
    for (const [file, name, end] of [
      ["20260820180036_add_authoritative_booking_service_sequences.sql", "create_public_booking_sequence", "sequence OTP profile invariant failed"],
      ["20260830005555_add_atomic_group_sequence_commit.sql", "create_public_group_booking_sequences", "group sequence OTP profile invariant failed"],
    ]) {
      const source = readFileSync(resolve(process.cwd(), `supabase/migrations/${file}`), "utf8");
      const definition = source.slice(source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`), source.indexOf("CREATE OR REPLACE FUNCTION public.replay_"));
      expect(definition.match(/OR v_otp_session\.verified_at IS NULL/g)).toHaveLength(1);
      expect(definition.match(/      UPDATE public\.client_profiles cp\n      SET phone_verified_at = CASE/g)).toHaveLength(1);
      expect(definition.split(`RAISE EXCEPTION '${end}';`)).toHaveLength(2);
      expect(migration).toContain(`'public.${name}(jsonb)'`);
    }
    expect(migration).toContain("OTP authority validation anchor mismatch");
    expect(migration).toContain("OTP authority profile invariant mismatch");
    expect(migration).not.toMatch(/(?:CREATE OR REPLACE FUNCTION|v_name\s*:=).*replay_public_/);
  });

  it("requires independent SMS proof before the public booking snapshot can expose CRM history", () => {
    const snapshot = migration.split("CREATE OR REPLACE FUNCTION public.get_booking_client_snapshot(")[1].split("$function$;")[0];
    for (const required of [
      "s.id = b.otp_session_id", "s.verified_channel = 'sms'", "s.salon_id = b.salon_id",
      "s.consumed_by_booking_id = b.id", "s.consumed_at >= s.verified_at", "s.consumed_at < s.expires_at",
      "pg_catalog.isfinite(s.consumed_at)", "pg_catalog.isfinite(s.verified_at)", "pg_catalog.isfinite(s.expires_at)",
      "public.canonical_phone(s.phone) = public.canonical_phone(b.client_phone)",
      "public.canonical_phone(cp.phone) = public.canonical_phone(b.client_phone)",
      "b.created_at >= now() - interval '10 minutes'",
    ]) expect(snapshot).toContain(required);
  });

  it("ships rollback-only behavioral SQL with negative and positive authority controls", () => {
    expect(sqlProof.trimEnd()).toMatch(/ROLLBACK;$/);
    for (const required of [
      "historical/omitted proof must stay untrusted", "consumed proof rebound", "exact replay",
      "non-phone owner stamped profile evidence", "exact SMS snapshot unavailable",
      "booking capability alone exposed CRM history", "non-SMS booking exposed CRM history", "foreign salon confirmation",
    ]) expect(sqlProof).toContain(required);
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260902190000_expose_turniq_operational_feature_flag.sql",
  ),
  "utf8",
);

describe("TurnIQ authenticated operational projection boundary", () => {
  it("exposes only the bounded TurnIQ boolean through the member loader", () => {
    expect(migration).toContain("'turniq_trust_engine_enabled'");
    expect(migration).toMatch(
      /jsonb_typeof\(flag\.value\) = 'boolean'[\s\S]*?'turniq_trust_engine_enabled'/,
    );
    expect(migration).not.toContain("'payment_provider'");
    expect(migration).not.toContain("'owner_phone'");
    expect(migration).not.toContain("'ai_manager_instructions'");
  });

  it("keeps active-session, membership, and least-privilege checks intact", () => {
    expect(migration).toContain("public.current_auth_session_is_active()");
    expect(migration).toContain("sm.user_id = v_actor_id");
    expect(migration).toContain("sm.salon_id = p_salon_id");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.load_salon_member_operational_profile\(uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.load_salon_member_operational_profile\(uuid\)[\s\S]*?TO authenticated/,
    );
  });

  it("documents an audit-preserving rollback", () => {
    expect(migration).toContain("Do not change salon feature flags or ledger data");
    expect(migration).not.toMatch(/UPDATE public\.salons|DELETE FROM public\.turniq_/i);
  });
});

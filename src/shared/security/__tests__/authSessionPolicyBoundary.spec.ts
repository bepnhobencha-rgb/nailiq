import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Supabase Auth session policy boundary", () => {
  it("pins a short JWT, refresh rotation, and explicit local session limits", () => {
    const config = read("supabase/config.toml");
    expect(config).toMatch(/\[auth\][\s\S]*jwt_expiry = 900/);
    expect(config).toMatch(/enable_refresh_token_rotation = true/);
    expect(config).toMatch(/refresh_token_reuse_interval = 10/);
    expect(config).toMatch(
      /\[auth\.sessions\][\s\S]*timebox = "12h"[\s\S]*inactivity_timeout = "30m"/,
    );
  });

  it("keeps the immediate-revocation RPC non-public and exactly session-bound", () => {
    const migration = read(
      "supabase/migrations/20260820230000_add_current_auth_session_validation.sql",
    );
    expect(migration).toContain("FROM auth.sessions AS s");
    expect(migration).toContain("s.id = v_session_id");
    expect(migration).toContain("s.user_id = v_subject");
    expect(migration).toContain("v_claims->>'aud' IS DISTINCT FROM 'authenticated'");
    expect(migration).toContain("v_exp <= v_now_epoch");
    expect(migration).toContain("v_claims ? 'is_anonymous'");
    expect(migration).not.toContain("auth.role()");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.current_auth_session_is_active() FROM PUBLIC",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.current_auth_session_is_active() TO authenticated",
    );
  });

  it("requires remote Auth validation before the session_id database proof", () => {
    const helper = read("src/shared/auth/requireActiveAuthSession.ts");
    expect(helper.indexOf("client.auth.getUser()")).toBeLessThan(
      helper.indexOf('client.rpc("current_auth_session_is_active")'),
    );
    expect(helper).not.toMatch(/getSession\(|jwtVerify\(|\.decode\(/);
  });
});

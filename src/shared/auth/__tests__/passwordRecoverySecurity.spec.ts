import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  canonicalPasswordResetEmail,
  isAcceptableRecoveryPassword,
  issuePasswordRecoveryCapability,
  issuePasswordRecoveryIntent,
  passwordRecoveryRedirectUrl,
  verifyPasswordRecoveryCapability,
  verifyPasswordRecoveryIntent,
} from "../passwordRecoverySecurity";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

describe("password recovery security primitives", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("PASSWORD_RECOVERY_SIGNING_SECRET", "x".repeat(64));
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example");
  });

  it("normalizes bounded email and rejects malformed identity without provider work", () => {
    expect(canonicalPasswordResetEmail(" OWNER@Example.com ")).toBe(
      "owner@example.com",
    );
    expect(canonicalPasswordResetEmail("owner@example")).toBeNull();
    expect(canonicalPasswordResetEmail(`${"a".repeat(250)}@e.co`)).toBeNull();
  });

  it("enforces one shared 8-72 character password boundary", () => {
    expect(isAcceptableRecoveryPassword("a".repeat(7))).toBe(false);
    expect(isAcceptableRecoveryPassword("a".repeat(8))).toBe(true);
    expect(isAcceptableRecoveryPassword("a".repeat(72))).toBe(true);
    expect(isAcceptableRecoveryPassword("a".repeat(73))).toBe(false);
    expect(isAcceptableRecoveryPassword("password\0x")).toBe(false);
  });

  it("constructs only a fixed recovery path on the canonical HTTPS origin", () => {
    expect(passwordRecoveryRedirectUrl("salon")).toBe(
      "https://app.example/auth/recovery?surface=salon",
    );
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example/attacker");
    expect(() => passwordRecoveryRedirectUrl()).toThrow(
      "password_recovery_origin_invalid",
    );
  });

  it("binds a short-lived capability to the exact user and Auth session", () => {
    const token = issuePasswordRecoveryCapability({
      userId: USER_ID,
      sessionId: SESSION_ID,
      nowSeconds: 1_000,
    });
    expect(
      verifyPasswordRecoveryCapability({
        token,
        userId: USER_ID,
        sessionId: SESSION_ID,
        nowSeconds: 1_001,
      }),
    ).toBe(true);
    expect(
      verifyPasswordRecoveryCapability({
        token,
        userId: USER_ID,
        sessionId: "33333333-3333-4333-8333-333333333333",
        nowSeconds: 1_001,
      }),
    ).toBe(false);
    expect(
      verifyPasswordRecoveryCapability({
        token: `${token.slice(0, -1)}x`,
        userId: USER_ID,
        sessionId: SESSION_ID,
        nowSeconds: 1_001,
      }),
    ).toBe(false);
    expect(
      verifyPasswordRecoveryCapability({
        token,
        userId: USER_ID,
        sessionId: SESSION_ID,
        nowSeconds: 1_901,
      }),
    ).toBe(false);
  });

  it("binds the emailed recovery intent to the exact email and surface", () => {
    const token = issuePasswordRecoveryIntent({
      email: "owner@example.com",
      surface: "salon",
      nowSeconds: 1_000,
    });
    expect(
      verifyPasswordRecoveryIntent({
        token,
        surface: "salon",
        email: "OWNER@example.com",
        nowSeconds: 1_001,
      }),
    ).toBe(true);
    expect(
      verifyPasswordRecoveryIntent({
        token,
        surface: "superadmin",
        email: "owner@example.com",
        nowSeconds: 1_001,
      }),
    ).toBe(false);
    expect(
      verifyPasswordRecoveryIntent({
        token,
        surface: "salon",
        email: "other@example.com",
        nowSeconds: 1_001,
      }),
    ).toBe(false);
  });
});

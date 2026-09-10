import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), list: vi.fn(), challenge: vi.fn(), verify: vi.fn() }));
vi.mock("@/shared/auth/requireActiveSuperAdminSession", () => ({ requireActiveSuperAdminSession: mocks.access }));
import { verifyMfaChallenge } from "../mfaActions";
const unavailable = { ok: false, error: "verification_unavailable" };
describe("MFA challenge recovery boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.access.mockResolvedValue({ ok: true, supabase: { auth: { mfa: {
      listFactors: mocks.list, challenge: mocks.challenge, verify: mocks.verify,
    } } } });
    mocks.list.mockResolvedValue({ data: { totp: [{ id: "pending", status: "unverified" }, { id: "verified", status: "verified" }] }, error: null });
    mocks.challenge.mockResolvedValue({ data: { id: "challenge" }, error: null });
    mocks.verify.mockResolvedValue({ data: { user: { id: "qa" } }, error: null });
  });
  for (const code of ["unauthenticated", "session_revoked", "forbidden"]) {
    it(`denies ${code} before any factor lookup or mutation`, async () => {
      mocks.access.mockResolvedValue({ ok: false, code });
      await expect(verifyMfaChallenge("123456")).resolves.toEqual({ ok: false, error: "unauthorized" });
      expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.challenge).not.toHaveBeenCalled(); expect(mocks.verify).not.toHaveBeenCalled();
    });
  }
  it("distinguishes an Auth outage from an expired session", async () => {
    mocks.access.mockResolvedValue({ ok: false, code: "auth_unavailable" });
    await expect(verifyMfaChallenge("123456")).resolves.toEqual(unavailable);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("contains a rejected authority lookup", async () => {
    mocks.access.mockRejectedValue(new Error("private Auth detail"));
    await expect(verifyMfaChallenge("123456")).resolves.toEqual(unavailable);
  });
  for (const method of ["list", "challenge", "verify"] as const) {
    for (const fault of ["returned", "rejected", "missing-data"]) {
      it(`${method} ${fault} does not claim invalid code or success`, async () => {
        if (fault === "rejected") mocks[method].mockRejectedValue(new Error("private Auth detail"));
        else mocks[method].mockResolvedValue({ data: null, error: fault === "returned" ? { message: "private Auth detail", status: 503 } : null });
        await expect(verifyMfaChallenge("123456")).resolves.toEqual(unavailable);
        if (method === "list") expect(mocks.challenge).not.toHaveBeenCalled();
        if (method !== "verify") expect(mocks.verify).not.toHaveBeenCalled();
      });
    }
  }
  for (const code of ["mfa_verification_failed", "mfa_challenge_expired"]) {
    it(`classifies confirmed ${code} as invalid code`, async () => {
      mocks.verify.mockResolvedValue({ data: null, error: { code } });
      await expect(verifyMfaChallenge("123456")).resolves.toEqual({ ok: false, error: "invalid_code" });
    });
  }
  it("does not call rate limiting an invalid code", async () => {
    mocks.verify.mockResolvedValue({ data: null, error: { code: "over_request_rate_limit", status: 429 } });
    await expect(verifyMfaChallenge("123456")).resolves.toEqual(unavailable);
  });
  for (const code of ["", "12345", "1234567", "12x456"]) {
    it(`rejects malformed input ${JSON.stringify(code)} without an Auth mutation`, async () => {
      await expect(verifyMfaChallenge(code)).resolves.toEqual({ ok: false, error: "invalid_code" });
      expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.challenge).not.toHaveBeenCalled(); expect(mocks.verify).not.toHaveBeenCalled();
    });
  }
  it("does not challenge an unverified factor", async () => {
    mocks.list.mockResolvedValue({ data: { totp: [{ id: "pending", status: "unverified" }] }, error: null });
    await expect(verifyMfaChallenge("123456")).resolves.toEqual({ ok: false, error: "invalid_code" });
    expect(mocks.challenge).not.toHaveBeenCalled(); expect(mocks.verify).not.toHaveBeenCalled();
  });
  it("uses the server-selected verified factor and confirms only a successful response", async () => {
    await expect(verifyMfaChallenge(" 123456 ")).resolves.toEqual({ ok: true });
    expect(mocks.challenge).toHaveBeenCalledExactlyOnceWith({ factorId: "verified" });
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith({ factorId: "verified", challengeId: "challenge", code: "123456" });
  });
});

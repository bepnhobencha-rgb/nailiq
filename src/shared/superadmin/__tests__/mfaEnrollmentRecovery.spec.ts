import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), list: vi.fn(), enroll: vi.fn(), remove: vi.fn(), challenge: vi.fn(), verify: vi.fn() }));
vi.mock("@/shared/auth/requireActiveSuperAdminSession", () => ({ requireActiveSuperAdminSession: mocks.access }));
import { startMfaEnroll, verifyMfaEnroll, unenrollMfa } from "../mfaActions";
const operations = [
  { name: "start", call: () => startMfaEnroll(), unavailable: "enroll_failed", methods: ["list", "remove", "enroll"] as const },
  { name: "confirm", call: () => verifyMfaEnroll("pending", "123456"), unavailable: "verification_unavailable", methods: ["challenge", "verify"] as const },
  { name: "disable", call: () => unenrollMfa("verified"), unavailable: "unenroll_failed", methods: ["remove"] as const },
];
describe("MFA enrollment response recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.access.mockResolvedValue({ ok: true, supabase: { auth: { mfa: {
      listFactors: mocks.list, enroll: mocks.enroll, unenroll: mocks.remove, challenge: mocks.challenge, verify: mocks.verify,
    } } } });
    mocks.list.mockResolvedValue({ data: { totp: [{ id: "pending", status: "unverified" }, { id: "verified", status: "verified" }] }, error: null });
    mocks.remove.mockResolvedValue({ data: { id: "pending" }, error: null });
    mocks.enroll.mockResolvedValue({ data: { id: "new-factor", totp: { qr_code: "fake-qr", secret: "fake-secret" } }, error: null });
    mocks.challenge.mockResolvedValue({ data: { id: "challenge" }, error: null });
    mocks.verify.mockResolvedValue({ data: { user: { id: "qa" } }, error: null });
  });
  for (const op of operations) {
    for (const code of ["unauthenticated", "session_revoked", "forbidden", "auth_unavailable"]) {
      it(`${op.name}: ${code} stops all factor operations`, async () => {
        mocks.access.mockResolvedValue({ ok: false, code });
        await expect(op.call()).resolves.toEqual({ ok: false, error: code === "auth_unavailable" ? op.unavailable : "unauthorized" });
        for (const method of ["list", "remove", "enroll", "challenge", "verify"] as const) expect(mocks[method]).not.toHaveBeenCalled();
      });
    }
    it(`${op.name}: rejected authority lookup is contained`, async () => {
      mocks.access.mockRejectedValue(new Error("private Auth detail"));
      await expect(op.call()).resolves.toEqual({ ok: false, error: op.unavailable });
    });
    for (const method of op.methods) for (const fault of ["returned", "rejected", "missing-data"]) {
      it(`${op.name}: ${method} ${fault} stops without success or automatic replay`, async () => {
        if (fault === "rejected") mocks[method].mockRejectedValue(new Error("private Auth detail"));
        else mocks[method].mockResolvedValue({ data: null, error: fault === "returned" ? { message: "private Auth detail", status: 503 } : null });
        await expect(op.call()).resolves.toEqual({ ok: false, error: op.unavailable });
        expect(mocks[method]).toHaveBeenCalledTimes(1);
        if (op.name === "start" && method !== "enroll") expect(mocks.enroll).not.toHaveBeenCalled();
        if (method === "list") expect(mocks.remove).not.toHaveBeenCalled();
        if (method === "challenge") expect(mocks.verify).not.toHaveBeenCalled();
      });
    }
  }
  it("start cleans only unverified factors before returning the new secret", async () => {
    await expect(startMfaEnroll()).resolves.toEqual({ ok: true, factorId: "new-factor", qrSvg: "fake-qr", secret: "fake-secret" });
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({ factorId: "pending" });
    expect(mocks.enroll).toHaveBeenCalledTimes(1);
    expect(mocks.remove.mock.invocationCallOrder[0]).toBeLessThan(mocks.enroll.mock.invocationCallOrder[0]);
  });
  for (const code of ["mfa_verification_failed", "mfa_challenge_expired"]) {
    it(`confirm recognizes ${code} as a correctable code error`, async () => {
      mocks.verify.mockResolvedValue({ data: null, error: { code } });
      await expect(verifyMfaEnroll("pending", "123456")).resolves.toEqual({ ok: false, error: "invalid_code" });
    });
  }
  it("rate limiting is not an invalid code", async () => {
    mocks.verify.mockResolvedValue({ data: null, error: { code: "over_request_rate_limit", status: 429 } });
    await expect(verifyMfaEnroll("pending", "123456")).resolves.toEqual({ ok: false, error: "verification_unavailable" });
  });
  for (const code of ["", "12345", "1234567", "12x456"]) it(`malformed code ${JSON.stringify(code)} cannot mutate Auth`, async () => {
    await expect(verifyMfaEnroll("pending", code)).resolves.toEqual({ ok: false, error: "invalid_code" });
    expect(mocks.challenge).not.toHaveBeenCalled(); expect(mocks.verify).not.toHaveBeenCalled();
  });
  it("missing factor cannot verify or remove", async () => {
    await expect(verifyMfaEnroll("", "123456")).resolves.toEqual({ ok: false, error: "invalid_code" });
    await expect(unenrollMfa("")).resolves.toEqual({ ok: false, error: "unenroll_failed" });
    expect(mocks.challenge).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("confirm binds the requested factor and challenge and trims the code", async () => {
    await expect(verifyMfaEnroll("pending", " 123456 ")).resolves.toEqual({ ok: true });
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith({ factorId: "pending", challengeId: "challenge", code: "123456" });
  });
  it("disable confirms only the requested factor removal", async () => {
    await expect(unenrollMfa("verified")).resolves.toEqual({ ok: true });
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({ factorId: "verified" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), list: vi.fn() }));
vi.mock("@/shared/auth/requireActiveSuperAdminSession", () => ({ requireActiveSuperAdminSession: mocks.access }));
import { getMfaStatus } from "../mfaActions";
describe("MFA status read boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.access.mockResolvedValue({ ok: true, supabase: { auth: { mfa: { listFactors: mocks.list } } } });
  });
  it("does not mistake a returned Auth error for disabled 2FA", async () => {
    mocks.list.mockResolvedValue({ data: null, error: { message: "private Auth detail" } });
    await expect(getMfaStatus()).resolves.toEqual({ ok: false, error: "load_failed" });
  });
  it("contains a rejected Auth read without exposing provider details", async () => {
    mocks.list.mockRejectedValue(new Error("private Auth detail"));
    await expect(getMfaStatus()).resolves.toEqual({ ok: false, error: "load_failed" });
  });
  it("requires data before calling an account unenrolled", async () => {
    mocks.list.mockResolvedValue({ data: null, error: null });
    await expect(getMfaStatus()).resolves.toEqual({ ok: false, error: "load_failed" });
  });
  it("contains a rejected session lookup", async () => {
    mocks.access.mockRejectedValue(new Error("private session detail"));
    await expect(getMfaStatus()).resolves.toEqual({ ok: false, error: "load_failed" });
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("denies missing superadmin authority without listing factors", async () => {
    mocks.access.mockResolvedValue({ ok: false });
    await expect(getMfaStatus()).resolves.toEqual({ ok: false, error: "unauthorized" });
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("reports verified TOTP only after successful read", async () => {
    mocks.list.mockResolvedValue({ data: { totp: [{ id: "pending", status: "unverified" }, { id: "verified", status: "verified" }] }, error: null });
    await expect(getMfaStatus()).resolves.toEqual({ ok: true, enrolled: true, factorId: "verified" });
  });
  it("reports OFF after a successful empty read", async () => {
    mocks.list.mockResolvedValue({ data: { totp: [] }, error: null });
    await expect(getMfaStatus()).resolves.toEqual({ ok: true, enrolled: false, factorId: null });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  recovery: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  limit: vi.fn(),
  maybeSingle: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (destination: string): never => {
    throw { kind: "redirect", destination };
  },
}));
vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/shared/auth/requireActivePasswordRecoverySession", () => ({
  requireActivePasswordRecoverySession: mocks.recovery,
}));
vi.mock("./SalonOwnerResetPasswordForm", () => ({
  SalonOwnerResetPasswordForm: () => null,
  SalonOwnerResetPasswordHeader: () => null,
}));

import ResetPasswordPage from "./page";
import { SalonOwnerResetPasswordForm } from "./SalonOwnerResetPasswordForm";

describe("password reset page membership boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createClient.mockResolvedValue({
      from: mocks.from,
      auth: { signOut: mocks.signOut },
    });
    mocks.recovery.mockResolvedValue({ ok: true, user: { id: "recovery-user" } });
    mocks.from.mockReturnValue({ select: mocks.select });
    mocks.select.mockReturnValue({ eq: mocks.eq });
    mocks.eq.mockReturnValue({ limit: mocks.limit });
    mocks.limit.mockReturnValue({ maybeSingle: mocks.maybeSingle });
    mocks.maybeSingle.mockResolvedValue({ data: { id: "membership" }, error: null });
    mocks.signOut.mockResolvedValue({ error: null });
  });

  it.each([
    { code: "57014", message: "canceling statement due to statement timeout" },
    { code: "PGRST000", message: "database connection unavailable" },
    { code: "", message: "TypeError: fetch failed" },
  ])("preserves sessions and denies form access on membership read error $code", async (error) => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error });
    const result = await ResetPasswordPage().catch((value: unknown) => value);
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "redirect",
      destination: "/login/forgot-password?notice=temporarily_unavailable",
    });
  });

  it("treats an error with partial data as unavailable rather than granting access", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { id: "membership" },
      error: { code: "unknown", message: "incomplete result" },
    });
    const result = await ResetPasswordPage().catch((value: unknown) => value);
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "redirect",
      destination: "/login/forgot-password?notice=temporarily_unavailable",
    });
  });

  it("retains the existing denial for a confirmed missing membership", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(ResetPasswordPage()).rejects.toEqual({
      kind: "redirect", destination: "/login",
    });
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "global" });
  });

  it.each([
    ["no_recovery_session", "invalid_or_expired"],
    ["auth_unavailable", "temporarily_unavailable"],
  ])("rejects %s before querying membership", async (code, notice) => {
    mocks.recovery.mockResolvedValue({ ok: false, code });
    await expect(ResetPasswordPage()).rejects.toEqual({
      kind: "redirect", destination: `/login/forgot-password?notice=${notice}`,
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("renders the form only after recovery and membership are confirmed", async () => {
    const page = await ResetPasswordPage();
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith("salon_members");
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith("id");
    expect(mocks.eq).toHaveBeenCalledExactlyOnceWith("user_id", "recovery-user");
    expect(mocks.limit).toHaveBeenCalledExactlyOnceWith(1);
    expect(page.props.children[1].type).toBe(SalonOwnerResetPasswordForm);
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});


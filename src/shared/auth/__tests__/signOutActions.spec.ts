import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), signOut: vi.fn(), getUser: vi.fn(), audit: vi.fn(),
  redirect: vi.fn((destination: string): never => { throw { kind: "redirect", destination }; }),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/shared/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/shared/dashboard/recordAuthEvent", () => ({ recordAuthEvent: mocks.audit }));
import { signOutAction } from "@/shared/dashboard/salonOwnerActions";
import { logoutSuperadmin, signOutSuperadminAction } from "@/shared/superadmin/superadminAuth";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue({ auth: { signOut: mocks.signOut, getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id: "synthetic-user" } } });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.audit.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

for (const [name, action, destination] of [
  ["salon", signOutAction, "/login"],
  ["superadmin", signOutSuperadminAction, "/superadmin/login"],
] as const) {
  describe(`${name} sign-out response`, () => {
    it("does not redirect or audit a provider failure as a completed logout", async () => {
      mocks.signOut.mockResolvedValue({ error: { status: 503, message: "synthetic provider error" } });
      await expect(action()).resolves.toEqual({ ok: false, error: "server_error" });
      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    });
    it("returns a retryable result on a thrown provider failure", async () => {
      mocks.signOut.mockRejectedValue(new Error("synthetic network failure"));
      await expect(action()).resolves.toEqual({ ok: false, error: "server_error" });
      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    });
    it("returns a retryable result if client creation fails", async () => {
      mocks.createClient.mockRejectedValue(new Error("synthetic unavailable client"));
      await expect(action()).resolves.toEqual({ ok: false, error: "server_error" });
      expect(mocks.redirect).not.toHaveBeenCalled();
    });
    it("keeps default global sign-out and lets the successful redirect propagate", async () => {
      await expect(action()).rejects.toMatchObject({ kind: "redirect", destination });
      expect(mocks.signOut).toHaveBeenCalledWith();
    });
    it("can retry after a provider error and redirect only after success", async () => {
      mocks.signOut.mockResolvedValueOnce({ error: { status: 503 } });
      await expect(action()).resolves.toEqual({ ok: false, error: "server_error" });
      await expect(action()).rejects.toMatchObject({ destination });
      expect(mocks.signOut).toHaveBeenCalledTimes(2);
    });
  });
}
it("salon logout audits the authenticated actor only after sign-out succeeds", async () => {
  await expect(signOutAction()).rejects.toMatchObject({ destination: "/login" });
  expect(mocks.audit).toHaveBeenCalledWith({ event: "logout", userId: "synthetic-user" });
  expect(mocks.audit.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.signOut.mock.invocationCallOrder[0]);
});
it("a failed best-effort actor lookup does not block sign-out", async () => {
  mocks.getUser.mockRejectedValue(new Error("synthetic lookup failure"));
  await expect(signOutAction()).rejects.toMatchObject({ destination: "/login" });
  expect(mocks.signOut).toHaveBeenCalledTimes(1);
});
it("the non-redirecting superadmin helper does not claim success on failure", async () => {
  mocks.signOut.mockResolvedValue({ error: { status: 503 } });
  await expect(logoutSuperadmin()).resolves.toEqual({ ok: false, error: "server_error" });
});

it("a failed audit cannot undo a successful sign-out redirect", async () => {
  mocks.audit.mockRejectedValue(new Error("synthetic audit failure"));
  await expect(signOutAction()).rejects.toMatchObject({ destination: "/login" });
  expect(mocks.signOut).toHaveBeenCalledTimes(1);
});
it("does not invent an audit actor when no user remains", async () => {
  mocks.getUser.mockResolvedValue({ data: { user: null } });
  await expect(signOutAction()).rejects.toMatchObject({ destination: "/login" });
  expect(mocks.audit).not.toHaveBeenCalled();
});

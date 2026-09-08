import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("@/shared/auth/requireActiveSuperAdminSession", () => ({
  requireActiveSuperAdminSession: mocks.session,
}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

import { requireSuperadminPage } from "../requireSuperadminPage";

// Independent acceptance matrix: do not derive expected authority from nav.ts.
const roles = ["founder", "ops_admin", "support_admin", "billing_admin", "ai_admin", "readonly_analyst"] as const;
const sections: Record<string, readonly string[]> = {
  dashboard: roles,
  salons: ["founder", "ops_admin", "support_admin", "billing_admin"],
  users: ["founder", "ops_admin", "support_admin"],
  operations: ["founder", "ops_admin"],
  support: ["founder", "ops_admin", "support_admin", "readonly_analyst"],
  analytics: roles,
  ai: ["founder", "ai_admin"],
  billing: ["founder", "billing_admin"],
  security: ["founder", "ops_admin"],
  settings: ["founder", "ops_admin"],
};

beforeEach(() => vi.clearAllMocks());

describe("direct SuperAdmin page access", () => {
  for (const [section, allowed] of Object.entries(sections)) {
    for (const role of roles) {
      it(`${role} ${allowed.includes(role) ? "can" : "cannot"} reach ${section}`, async () => {
        const session = { ok: true, role, user: { id: "qa-operator" } };
        mocks.session.mockResolvedValue(session);
        if (allowed.includes(role)) {
          expect(await requireSuperadminPage(section)).toBe(session);
        } else {
          await expect(requireSuperadminPage(section)).rejects.toThrow("NEXT_NOT_FOUND");
        }
      });
    }
  }

  for (const code of ["unauthenticated", "session_revoked", "auth_unavailable", "forbidden"]) {
    it(`rejects ${code} even on the shared dashboard`, async () => {
      mocks.session.mockResolvedValue({ ok: false, code });
      await expect(requireSuperadminPage("dashboard")).rejects.toThrow("NEXT_NOT_FOUND");
    });
  }

  it("rejects an unknown section even for founder", async () => {
    mocks.session.mockResolvedValue({ ok: true, role: "founder" });
    await expect(requireSuperadminPage("unregistered-module")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("does not grant an unknown role dashboard access", async () => {
    mocks.session.mockResolvedValue({ ok: true, role: "future-role" });
    await expect(requireSuperadminPage("dashboard")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

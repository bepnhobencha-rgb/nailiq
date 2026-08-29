import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getSuperAdminRole: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
  resolveReleaseReviewNotice: vi.fn(),
  requireActiveSuperAdminSession: vi.fn(),
  clearInactiveServerSession: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}));
vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/shared/lib/superadmin", () => ({
  getSuperAdminRole: mocks.getSuperAdminRole,
}));
vi.mock("@/shared/auth/requireActiveSuperAdminSession", () => ({
  requireActiveSuperAdminSession: mocks.requireActiveSuperAdminSession,
  clearInactiveServerSession: mocks.clearInactiveServerSession,
}));
vi.mock("@/shared/superadmin/releaseReviewContext", () => ({
  currentReleaseReviewContext: vi.fn(() => ({ deploymentId: "qa" })),
}));
vi.mock("@/shared/superadmin/releaseReviewStore", () => ({
  resolveReleaseReviewNotice: mocks.resolveReleaseReviewNotice,
}));
vi.mock("@/components/superadmin/SuperadminSidebar", () => ({
  SuperadminSidebar: () => "SUPERADMIN_SIDEBAR",
}));
vi.mock("@/components/superadmin/SuperadminBottomNav", () => ({
  SuperadminBottomNav: () => "SUPERADMIN_BOTTOM_NAV",
}));
vi.mock("@/components/superadmin/SuperadminTopBar", () => ({
  SuperadminTopBar: () => "SUPERADMIN_TOP_BAR",
}));
vi.mock("@/components/superadmin/ReleaseReviewNotice", () => ({
  ReleaseReviewNotice: () => "RELEASE_REVIEW_NOTICE",
}));
vi.mock("@/app/superadmin/login/SuperadminLoginForm", () => ({
  SuperadminLoginForm: () => "SUPERADMIN_LOGIN_FORM",
}));

import SuperadminShellLayout from "@/app/superadmin/(shell)/layout";
import SuperadminLoginPage from "@/app/superadmin/login/page";

function requestClient(userId: string | null) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
      }),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
          data: { currentLevel: "aal1", nextLevel: "aal1" },
        }),
      },
    },
  };
}

describe("platform superadmin shell boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redirect.mockImplementation((href: string) => {
      throw new Error(`REDIRECT:${href}`);
    });
    mocks.notFound.mockImplementation(() => {
      throw new Error("NOT_FOUND");
    });
    mocks.resolveReleaseReviewNotice.mockResolvedValue(null);
    mocks.clearInactiveServerSession.mockResolvedValue(undefined);
  });

  it("redirects an anonymous visitor before role or shell data", async () => {
    mocks.requireActiveSuperAdminSession.mockResolvedValue({
      ok: false,
      code: "unauthenticated",
      supabase: requestClient(null),
    });

    await expect(
      SuperadminShellLayout({ children: "PRIVATE" }),
    ).rejects.toThrow(
      "REDIRECT:/superadmin/login?notice=reauthentication_required",
    );
    expect(mocks.getSuperAdminRole).not.toHaveBeenCalled();
    expect(mocks.resolveReleaseReviewNotice).not.toHaveBeenCalled();
  });

  it("returns not-found for an authenticated salon staff account without a platform role", async () => {
    mocks.requireActiveSuperAdminSession.mockResolvedValue({
      ok: false,
      code: "forbidden",
      supabase: requestClient("salon-staff-user"),
    });

    await expect(
      SuperadminShellLayout({ children: "PRIVATE" }),
    ).rejects.toThrow("NOT_FOUND");
    expect(mocks.resolveReleaseReviewNotice).not.toHaveBeenCalled();
  });

  it.each([
    "founder",
    "ops_admin",
    "support_admin",
    "billing_admin",
    "ai_admin",
    "readonly_analyst",
  ])("allows an active %s platform role through the inherited shell", async (role) => {
    mocks.requireActiveSuperAdminSession.mockResolvedValue({
      ok: true,
      user: { id: "platform-user" },
      role,
      supabase: requestClient("platform-user"),
    });

    await expect(
      SuperadminShellLayout({ children: "PRIVATE" }),
    ).resolves.toBeTruthy();
  });

  it("shows a truthful re-authentication notice after session rejection", async () => {
    mocks.createClient.mockResolvedValue(requestClient(null));
    const page = await SuperadminLoginPage({
      searchParams: Promise.resolve({
        notice: "reauthentication_required",
      }),
    });
    const html = renderToStaticMarkup(page);
    expect(html).toContain("Your secure session ended or could not be verified");
    expect(html).toContain("superadmin-reauthentication-notice");
  });
});

describe("superadmin Server Action inventory", () => {
  it("keeps every action module in the platform-role inventory", () => {
    const root = resolve(process.cwd(), "src/shared/superadmin");
    const discovered = readdirSync(root)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => readFileSync(resolve(root, name), "utf8").startsWith('"use server"'))
      .sort();
    const expected = [
      "announcementsActions.ts",
      "auditLogActions.ts",
      "errorMonitorActions.ts",
      "guidedSetupQaControlAction.ts",
      "impersonationActions.ts",
      "mfaActions.ts",
      "multiServiceQaControlAction.ts",
      "multiServiceRolloutControlAction.ts",
      "releaseConciergeAction.ts",
      "releaseReviewActions.ts",
      "squareConnectionActions.ts",
      "superadminActions.ts",
      "superadminAuth.ts",
    ].sort();

    expect(discovered).toEqual(expected);
    for (const name of discovered) {
      const source = readFileSync(resolve(root, name), "utf8");
      // superadminAuth owns the intentionally public login/reset entry points;
      // every other action module must resolve an active Auth session and a
      // current platform role through the shared replay-safe revocation gate.
      if (basename(name) !== "superadminAuth.ts") {
        expect(source, `${name} must resolve an active platform session`).toContain(
          "requireActiveSuperAdminSession",
        );
      }
    }
  });

  it("keeps server-only platform analytics behind the same active-session gate", () => {
    for (const name of ["agentCertificationActions.ts", "aiCostActions.ts"]) {
      const source = readFileSync(
        resolve(process.cwd(), "src/shared/superadmin", name),
        "utf8",
      );
      expect(source, `${name} must reject revoked sessions`).toContain(
        "requireActiveSuperAdminSession",
      );
    }
  });
});

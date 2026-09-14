import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ open: true, language: "en" as "en" | "vi" }));

// Render the real open sheet without a DOM dependency. Only its local open
// state and external navigation/language providers are controlled here.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => actual.useState(initial === false ? state.open : initial),
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard/qa-mobile" }));
vi.mock("next/link", () => ({
  default: ({ children, prefetch, ...props }: { children: import("react").ReactNode; prefetch?: boolean }) => {
    void prefetch;
    return createElement("a", props, children);
  },
}));
vi.mock("@/shared/lib/useUserLanguage", () => ({ useUserLanguage: () => ({ language: state.language }) }));
vi.mock("@/components/user/GlobalLanguageToggle", () => ({ GlobalLanguageToggle: () => null }));
vi.mock("@/shared/auth/useSignOutAction", () => ({
  useSignOutAction: () => ({ pending: false, failed: false, run: vi.fn(), clearFailure: vi.fn() }),
}));
vi.mock("@/shared/dashboard/salonOwnerActions", () => ({ signOutAction: vi.fn() }));

import { MobileBottomNav } from "../MobileBottomNav";

function render(role?: string) {
  return renderToStaticMarkup(createElement(MobileBottomNav, { slug: "qa-mobile", role }));
}

describe("mobile account access across salon roles", () => {
  beforeEach(() => { state.open = true; state.language = "en"; });

  for (const language of ["en", "vi"] as const) {
    it.each(["owner", "admin", "senior", "receptionist", "nail_tech"])(
      `${language}: %s can reach the shared logout button without Settings`,
      (role) => {
        state.language = language;
        const html = render(role);
        expect(html).toContain('data-testid="mobile-more-sheet"');
        const account = html.match(/<section aria-labelledby="mobile-more-account">([\s\S]*?)<\/section>/)?.[1];
        expect(account).toBeDefined();
        expect(account).toMatch(new RegExp(`<button[^>]*type="button"[\\s\\S]*?${language === "vi" ? "Đăng xuất" : "Sign out"}<\\/button>`));
        expect(account).toContain("[&amp;&gt;button]:min-h-11");
        expect(html.includes('href="/dashboard/qa-mobile/settings"')).toBe(role === "owner" || role === "admin");
      },
    );
  }

  it.each([undefined, "manager", "unexpected"])("does not infer Settings permission for %s", (role) => {
    const html = render(role);
    expect(html).not.toContain('href="/dashboard/qa-mobile/settings"');
    expect(html).toContain("Sign out");
  });

  it("does not render account controls before the More sheet is opened", () => {
    state.open = false;
    const html = render("senior");
    expect(html).toContain('data-testid="mobile-more-trigger"');
    expect(html).not.toContain('data-testid="mobile-more-sheet"');
    expect(html).not.toContain("Sign out");
  });
});

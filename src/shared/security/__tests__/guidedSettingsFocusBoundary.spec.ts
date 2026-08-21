import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const page = read("src/app/dashboard/[slug]/settings/page.tsx");
const hub = read("src/components/dashboard/SalonSettingsHub.tsx");

describe("Guided Settings focus boundary", () => {
  it("derives the only visible section from the effective Guided flag", () => {
    expect(page).toContain('requestedSection === "integrations"');
    expect(page).toContain("guidedFocusSection={");
    expect(page).toContain("guidedSetupEnabled");
    expect(page).toContain('? "integrations"');
    expect(page).toContain(': "notifications"');
  });

  it("hides the desktop overview, jump bar, unrelated categories, plan and account actions", () => {
    expect(hub).toContain(
      'guidedFocusSection?: "notifications" | "integrations" | null',
    );
    expect(hub).toMatch(
      /settings-desktop-overview[\s\S]*?guidedFocusSection && "md:hidden"/,
    );
    expect(hub).toContain('guidedFocusSection === "notifications"');
    expect(hub).toContain('guidedFocusSection === "integrations"');
    expect(
      hub.match(/canManageSalonSettings && !guidedFocusSection/g),
    ).toHaveLength(4);
    expect(hub).toMatch(
      /!guidedFocusSection\s*\?\s*\(\s*<MobileAccountCard/,
    );
  });
});

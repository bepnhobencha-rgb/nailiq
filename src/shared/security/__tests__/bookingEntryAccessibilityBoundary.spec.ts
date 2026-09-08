import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(resolve(process.cwd(), relative), "utf8");

describe("public booking entry accessibility boundary", () => {
  it("keeps the floating language control inside a named navigation landmark", () => {
    const page = read("src/app/[slug]/page.tsx");

    expect(page).toMatch(
      /<nav\s+aria-label=\{lang === "vi"[\s\S]{0,300}<BookingLanguageToggle[\s\S]{0,100}<\/nav>/u,
    );
  });

  it.each([
    "booking-entry-recognized",
    "booking-entry-newgreeting",
  ])("uses the theme's readable text token for %s", (testId) => {
    const switcher = read("src/components/booking/BookingTypeSwitcher.tsx");
    const start = switcher.indexOf(`data-testid="${testId}"`);
    const greeting = switcher.slice(start, start + 220);

    expect(start).toBeGreaterThan(-1);
    expect(greeting).toContain("text-[var(--booking-text)]");
    expect(greeting).not.toContain("text-[var(--salon-primary)]");
  });
});

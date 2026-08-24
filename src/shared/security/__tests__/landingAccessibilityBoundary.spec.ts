import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(resolve(process.cwd(), relative), "utf8");

describe("landing accessibility boundary", () => {
  it("makes collapsed mobile navigation descendants non-focusable", () => {
    const navbar = read("src/components/landing/LandingNavbar.tsx");

    expect(navbar).toMatch(/aria-hidden=\{!open\}[\s\S]{0,80}inert=\{!open\}/u);
  });

  it("keeps the small social-media label at readable contrast", () => {
    const footer = read("src/components/landing/LandingFooter.tsx");

    expect(footer).toContain('className="text-xs text-nq-muted">{t.followUs}</span>');
    expect(footer).not.toContain('className="text-xs text-nq-muted/60">{t.followUs}</span>');
  });
});

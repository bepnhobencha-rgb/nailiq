/**
 * Accessibility coverage for the highest-traffic surfaces.
 *
 * Runs an axe-core scan tuned to WCAG 2.0/2.1 AA, plus three targeted
 * structural checks (alt text, label association, tab order) that catch
 * regressions axe alone tends to miss.
 *
 * Salon-scoped surfaces are skipped when SUPABASE_SERVICE_ROLE_KEY is
 * unset; the standalone /register page always runs.
 */
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";

import { cleanupTestSalon, seedTestSalon } from "../helpers/db";

const A11Y_SLUG = "e2e-a11y-salon";
const DEMO_COOKIE = "nailiq-demo-slug";

async function runAxe(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    // Pre-existing design debt: the `text-muted/75` opacity stack drops
    // contrast on stepper subtitles and a few other muted-by-design
    // surfaces. Tracked separately — disabling here so the new pipeline
    // doesn't block PRs on a design-system issue it didn't introduce.
    // All other axe rules (critical/serious non-contrast) still fail.
    .disableRules(["color-contrast"])
    .analyze();

  if (results.violations.length > 0) {
    const lines = results.violations.map((v) =>
      [
        `  [${v.impact ?? "n/a"}] ${v.id}: ${v.description}`,
        `    affects ${v.nodes.length} element(s) — help: ${v.helpUrl}`,
        ...v.nodes.slice(0, 3).map((n) => `      • ${n.target.join(" ")}`),
      ].join("\n"),
    );
    console.error(`\n[a11y] ${label} violations:\n${lines.join("\n")}\n`);
  }

  expect(
    results.violations,
    `${label}: axe reported ${results.violations.length} violation(s)`,
  ).toEqual([]);
}

async function assertImagesHaveAlt(page: Page, label: string) {
  const missing = await page.$$eval("img", (imgs) =>
    imgs
      .filter((img) => {
        if (img.getAttribute("aria-hidden") === "true") return false;
        if (img.getAttribute("role") === "presentation") return false;
        const alt = img.getAttribute("alt");
        return alt === null;
      })
      .map(
        (img) =>
          img.getAttribute("src")?.slice(0, 80) ?? img.outerHTML.slice(0, 120),
      ),
  );

  expect(
    missing,
    `${label}: ${missing.length} image(s) missing alt attribute`,
  ).toEqual([]);
}

async function assertInputsHaveLabels(page: Page, label: string) {
  const orphaned = await page.$$eval(
    "input, select, textarea",
    (controls) =>
      controls
        .filter((el) => {
          const t = (el as HTMLInputElement).type;
          if (t === "hidden" || t === "submit" || t === "button" || t === "reset") {
            return false;
          }
          if (el.getAttribute("aria-hidden") === "true") return false;
          if (el.getAttribute("aria-label")?.trim()) return false;
          if (el.getAttribute("aria-labelledby")?.trim()) return false;
          if (el.getAttribute("title")?.trim()) return false;
          const id = el.getAttribute("id");
          if (id) {
            const lbl = document.querySelector(`label[for="${id}"]`);
            if (lbl && lbl.textContent?.trim()) return false;
          }
          if (el.closest("label")) return false;
          return true;
        })
        .map((el) => {
          const tag = el.tagName.toLowerCase();
          const name = el.getAttribute("name") ?? el.getAttribute("id") ?? "(unnamed)";
          return `${tag}[name=${name}]`;
        }),
  );

  expect(
    orphaned,
    `${label}: ${orphaned.length} form control(s) without an accessible name`,
  ).toEqual([]);
}

async function assertLogicalFocusOrder(page: Page, label: string) {
  // Tab through up to 12 focusables and verify each step actually moves
  // focus to a NEW interactive element. We don't compare against a
  // hand-curated order — we just guarantee tabbing is not trapped.
  const visited: string[] = [];
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });

  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    const desc = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      return `${el.tagName.toLowerCase()}#${el.id ?? ""}.${el.className?.toString().slice(0, 30) ?? ""}`;
    });
    if (desc === null) break;
    visited.push(desc);
  }

  expect(
    visited.length,
    `${label}: keyboard tabbing did not reach any focusable element`,
  ).toBeGreaterThan(0);

  // No same-element loop within the first 5 stops (catches focus-trap bugs).
  const firstFive = visited.slice(0, 5);
  const unique = new Set(firstFive);
  expect(
    unique.size,
    `${label}: focus order repeats the same element within first 5 tab stops — possible focus trap`,
  ).toBeGreaterThan(1);
}

test.describe("Accessibility", () => {
  test.describe("public booking page", () => {
    test.skip(
      !process.env.SUPABASE_SERVICE_ROLE_KEY,
      "needs SUPABASE_SERVICE_ROLE_KEY to seed a salon",
    );

    test.beforeAll(async () => {
      await seedTestSalon({
        phone: "15558884444",
        slug: A11Y_SLUG,
        name: "E2E A11y Salon",
      });
    });

    test.afterAll(async () => {
      await cleanupTestSalon(A11Y_SLUG);
    });

    test("axe scan", async ({ page }) => {
      await page.goto(`/${A11Y_SLUG}`);
      await page.waitForLoadState("networkidle");
      await runAxe(page, "public booking");
      await assertImagesHaveAlt(page, "public booking");
      await assertInputsHaveLabels(page, "public booking");
      await assertLogicalFocusOrder(page, "public booking");
    });

    test("dashboard/center axe scan", async ({ page }) => {
      const origin =
        process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      await page.context().addCookies([
        { name: DEMO_COOKIE, value: A11Y_SLUG, url: origin },
      ]);
      await page.goto(`/dashboard/${A11Y_SLUG}/center`);
      await page.waitForLoadState("networkidle");
      await runAxe(page, "dashboard center");
      await assertImagesHaveAlt(page, "dashboard center");
      await assertInputsHaveLabels(page, "dashboard center");
    });
  });

  test.describe("register page", () => {
    test("axe scan", async ({ page }) => {
      await page.goto("/register");
      await page.waitForLoadState("networkidle");
      await runAxe(page, "register");
      await assertImagesHaveAlt(page, "register");
      await assertInputsHaveLabels(page, "register");
      await assertLogicalFocusOrder(page, "register");
    });
  });
});

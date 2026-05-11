/**
 * Copy & i18n live-render check.
 *
 * Loads the highest-traffic surfaces in both languages and asserts that
 * no raw translation keys, `[object Object]` strings, or `undefined`
 * leak into the rendered output. Catches the regression where a key was
 * added to one locale file but missed in another and the user-visible
 * text becomes the key name itself.
 *
 * Requires no DB seeding for /register — only the salon route does, so
 * that case is skipped when SUPABASE_SERVICE_ROLE_KEY is unset.
 */
import { test, expect, type Page } from "@playwright/test";

import { userEn, userVi } from "@/shared/i18n/user";

import { cleanupTestSalon, seedTestSalon } from "../helpers/db";

/**
 * Force the user-language preference before any client script runs.
 * `useUserLanguage` reads `nailiq-user-lang` from localStorage on mount,
 * not `?lang=` (that query param is not wired). Without this, lang=vi
 * would silently fall back to the default and the EN/VI parity check
 * would assert against the same bundle twice.
 */
async function presetUserLang(page: Page, lang: "en" | "vi") {
  await page.addInitScript((l) => {
    try {
      window.localStorage.setItem("nailiq-user-lang", l);
    } catch {
      /* private mode / quota — fall through */
    }
  }, lang);
}

const COPY_SLUG = "e2e-copy-salon";

const RAW_KEY_PATTERN = /(?:^|\b)[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9_]*){1,}(?:$|\b)/;

async function assertNoLeakedKeys(page: Page, lang: "en" | "vi") {
  const visibleText = await page.evaluate(() => {
    return document.body?.innerText ?? "";
  });

  expect(visibleText, `[${lang}] page rendered no visible text`).not.toEqual("");

  // Must not show JS sentinel values.
  expect(visibleText).not.toContain("[object Object]");
  expect(visibleText).not.toContain("undefined");
  expect(visibleText).not.toContain("null");

  // Hunt for unresolved i18n keys (e.g. "home.headline", "register.phoneEntryTitle").
  // Only flag bare dotted-identifier tokens on a line by themselves; words like
  // "node_modules" or "Next.js" never match because the pattern requires the
  // segment after the dot to start with a lowercase letter and the whole token
  // to be word-bounded.
  const lines = visibleText.split(/\n/).map((l: string) => l.trim());
  const suspicious = lines.filter((line: string) => {
    if (!line) return false;
    if (line.length > 80) return false;
    if (/^https?:\/\//.test(line)) return false;
    return RAW_KEY_PATTERN.test(line) && !/\s/.test(line);
  });

  expect(
    suspicious,
    `[${lang}] visible text looks like an unresolved i18n key — got: ${JSON.stringify(suspicious.slice(0, 3))}`,
  ).toEqual([]);

  const title = await page.title();
  expect(title, `[${lang}] page title is empty`).not.toEqual("");
  expect(title).not.toContain("undefined");
}

test.describe("Copy & i18n live-render check", () => {
  test.describe("public booking page", () => {
    test.skip(
      !process.env.SUPABASE_SERVICE_ROLE_KEY,
      "needs SUPABASE_SERVICE_ROLE_KEY to seed a salon",
    );

    test.beforeAll(async () => {
      await seedTestSalon({
        phone: "15558883333",
        slug: COPY_SLUG,
        name: "E2E Copy Salon",
      });
    });

    test.afterAll(async () => {
      await cleanupTestSalon(COPY_SLUG);
    });

    for (const lang of ["en", "vi"] as const) {
      test(`/${COPY_SLUG}?lang=${lang}`, async ({ page }) => {
        await page.goto(`/${COPY_SLUG}?lang=${lang}`);
        await page.waitForLoadState("networkidle");
        await assertNoLeakedKeys(page, lang);
      });
    }
  });

  test.describe("register page", () => {
    for (const lang of ["en", "vi"] as const) {
      test(`/register?lang=${lang}`, async ({ page }) => {
        await page.goto(`/register?lang=${lang}`);
        await page.waitForLoadState("networkidle");
        await assertNoLeakedKeys(page, lang);
      });
    }
  });

  test.describe("landing page", () => {
    // The marketing landing page renders the literal URL "nailiq.com/your-salon"
    // inside the how-it-works copy. That trips assertNoLeakedKeys' raw-key
    // regex (a lowercase.dot.lowercase token), so instead of the generic
    // leak hunt we assert that the canonical i18n strings from the bundle
    // actually render. This is the stronger signal: it catches both
    // unresolved-key leaks AND missing-translation fallbacks. Asserting
    // against `userEn`/`userVi` (not hardcoded copy) means future pricing
    // / hero edits in the bundle keep this test passing automatically.
    for (const lang of ["en", "vi"] as const) {
      test(`landing renders ${lang} i18n strings`, async ({ page }) => {
        const messages = lang === "vi" ? userVi : userEn;
        await presetUserLang(page, lang);
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        const visibleText = await page.evaluate(
          () => document.body?.innerText ?? "",
        );

        expect(visibleText).not.toContain("[object Object]");

        // Hero — proves the lang switch took effect.
        expect(
          visibleText,
          `[${lang}] landing hero headline not rendered`,
        ).toContain(messages.home.landingH1Gold);

        // Pricing section — the part that motivated this test (plans
        // structure changed after the initial pipeline PR).
        const pricing = messages.landing.pricing;
        expect(
          visibleText,
          `[${lang}] pricing eyebrow "${pricing.eyebrow}" missing`,
        ).toContain(pricing.eyebrow);

        for (const plan of pricing.plans) {
          expect(
            visibleText,
            `[${lang}] plan name "${plan.name}" missing`,
          ).toContain(plan.name);
          expect(
            visibleText,
            `[${lang}] plan cta "${plan.cta}" missing`,
          ).toContain(plan.cta);
        }

        const title = await page.title();
        expect(title, `[${lang}] page title is empty`).not.toEqual("");
        expect(title).not.toContain("undefined");
      });
    }
  });
});

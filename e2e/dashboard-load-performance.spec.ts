import { createHash } from "node:crypto";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalon,
  seedTestSalonMember,
} from "./helpers/db";

const SLUG = "e2e-dashboard-load-performance";
const SALON_NAME = "E2E Dashboard Load Performance Salon";
const BOOKING_COUNT = 250;
const STAFF_COUNT = 10;
const SERVICE_COUNT = 20;
const COLD_SAMPLE_COUNT = 20;
const WARM_SAMPLE_COUNT = 20;
const P95_SLA_MS = 3_000;
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

let owner:
  | Awaited<ReturnType<typeof seedTestSalonMember>>
  | undefined;
let salonId: string | undefined;

function percentileNearestRank(samples: readonly number[], percentile: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1]!;
}

function summarize(samples: readonly number[]) {
  return {
    samplesMs: [...samples],
    p50Ms: percentileNearestRank(samples, 0.5),
    p95Ms: percentileNearestRank(samples, 0.95),
    maxMs: Math.max(...samples),
  };
}

async function loginAs(page: Page, account: { email: string; password: string }) {
  const digest = createHash("sha256").update(account.email).digest("hex");
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `2001:db8::${digest.slice(0, 4)}:${digest.slice(4, 8)}`,
  });
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(new RegExp(`/dashboard/${SLUG}`), { timeout: 30_000 });
  await expectDashboardReady(page);
}

async function expectDashboardReady(page: Page) {
  await expect(page.getByRole("heading", { name: SALON_NAME })).toBeVisible({
    timeout: 15_000,
  });
  const refresh = page.getByTestId("owner-refresh");
  await expect(refresh).toBeVisible({ timeout: 15_000 });
  await expect(refresh).toBeEnabled();
  await expect(page.getByTestId("owner-booking-link")).toBeVisible();
}

async function measureNavigation(page: Page) {
  const startedAt = performance.now();
  const response = await page.goto(`/dashboard/${SLUG}`);
  await expectDashboardReady(page);
  expect(response?.status()).toBeLessThan(400);
  const elapsedMs = Math.round(performance.now() - startedAt);
  // The dashboard intentionally keeps a Realtime connection open, so
  // `networkidle` can never be a readiness signal. Give linked RSC prefetches a
  // bounded settle window outside the measurement before closing the context.
  await page.waitForTimeout(750);
  return elapsedMs;
}

async function newAuthenticatedContext(
  browser: Browser,
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>,
) {
  return browser.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    storageState,
  });
}

async function seedRepresentativeDashboardData(targetSalonId: string) {
  const { data: extraStaff, error: staffError } = await db
    .from("staff")
    .insert(
      Array.from({ length: STAFF_COUNT - 1 }, (_, index) => ({
        salon_id: targetSalonId,
        name: `Performance Staff ${index + 2}`,
        job_role: "nail_tech",
      })),
    )
    .select("id");
  if (staffError) throw new Error(`seed representative staff: ${staffError.message}`);

  const { data: extraServices, error: serviceError } = await db
    .from("services")
    .insert(
      Array.from({ length: SERVICE_COUNT - 1 }, (_, index) => ({
        salon_id: targetSalonId,
        name: `Performance Service ${index + 2}`,
        price_cents: 2500 + index * 100,
        duration_minutes: 30 + (index % 4) * 15,
        buffer_minutes: 5,
      })),
    )
    .select("id");
  if (serviceError) {
    throw new Error(`seed representative services: ${serviceError.message}`);
  }

  const [{ data: allStaff, error: allStaffError }, { data: allServices, error: allServicesError }] =
    await Promise.all([
      db.from("staff").select("id").eq("salon_id", targetSalonId).order("id"),
      db.from("services").select("id, price_cents").eq("salon_id", targetSalonId).order("id"),
    ]);
  if (allStaffError || allServicesError) {
    throw new Error(
      `read representative fixtures: ${allStaffError?.message ?? allServicesError?.message}`,
    );
  }
  expect(allStaff).toHaveLength(STAFF_COUNT);
  expect(allServices).toHaveLength(SERVICE_COUNT);
  expect(extraStaff).toHaveLength(STAFF_COUNT - 1);
  expect(extraServices).toHaveLength(SERVICE_COUNT - 1);

  const nowMs = Date.now();
  const bookingRows = Array.from({ length: BOOKING_COUNT }, (_, index) => {
    const startMs = nowMs - (index + 1) * 60 * 60 * 1000;
    const service = allServices![index % allServices!.length]!;
    return {
      salon_id: targetSalonId,
      service_id: service.id,
      staff_id: allStaff![index % allStaff!.length]!.id,
      client_name: `Performance Guest ${String(index + 1).padStart(3, "0")}`,
      client_phone: null,
      client_notes: null,
      start_time_utc: new Date(startMs).toISOString(),
      end_time_utc: new Date(startMs + 45 * 60 * 1000).toISOString(),
      status: index % 20 === 0 ? "no_show" : index % 10 === 0 ? "cancelled" : "completed",
      source: "appointment",
      price_cents: Number(service.price_cents),
    };
  });
  const { error: bookingError } = await db.from("bookings").insert(bookingRows);
  if (bookingError) {
    throw new Error(`seed representative bookings: ${bookingError.message}`);
  }
}

test.describe("MQA-0145 — authenticated dashboard load latency", () => {
  test.beforeAll(async () => {
    const salon = await seedTestSalon({
      slug: SLUG,
      name: SALON_NAME,
      phone: "15553335555",
    });
    salonId = salon.salonId;
    await seedRepresentativeDashboardData(salon.salonId);
    owner = await seedTestSalonMember(salon.salonId, "owner");
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
    if (owner) await cleanupTestUser(owner.userId);
  });

  test("cold-browser and warm-session p95 stay below 3 seconds", async ({
    browser,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "The controlled local dashboard distribution is measured once in Chromium",
    );
    test.setTimeout(6 * 60_000);
    expect(owner).toBeDefined();
    expect(salonId).toBeDefined();

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const loginContext = await browser.newContext({ baseURL });
    const loginPage = await loginContext.newPage();
    await loginAs(loginPage, owner!);
    const storageState = await loginContext.storageState();
    await loginPage.goto("about:blank");
    await loginPage.waitForTimeout(250);
    await loginContext.close();

    // Compile and hydrate the route once outside the distribution. Cold samples
    // below still use a fresh browser context/cache, while the local server is warm.
    const warmupContext = await newAuthenticatedContext(browser, storageState);
    const warmupPage = await warmupContext.newPage();
    await measureNavigation(warmupPage);
    await warmupContext.close();

    const coldSamplesMs: number[] = [];
    for (let index = 0; index < COLD_SAMPLE_COUNT; index += 1) {
      const context = await newAuthenticatedContext(browser, storageState);
      const page = await context.newPage();
      try {
        const elapsedMs = await measureNavigation(page);
        coldSamplesMs.push(elapsedMs);
        console.info(
          `[MQA-0145] cold_sample=${index + 1}/${COLD_SAMPLE_COUNT} dashboard_ready_ms=${elapsedMs}`,
        );
      } finally {
        await context.close();
      }
    }

    const warmContext = await newAuthenticatedContext(browser, storageState);
    const warmPage = await warmContext.newPage();
    await measureNavigation(warmPage);
    const warmSamplesMs: number[] = [];
    try {
      for (let index = 0; index < WARM_SAMPLE_COUNT; index += 1) {
        const startedAt = performance.now();
        const response = await warmPage.reload();
        await expectDashboardReady(warmPage);
        expect(response?.status()).toBeLessThan(400);
        const elapsedMs = Math.round(performance.now() - startedAt);
        await warmPage.waitForTimeout(750);
        warmSamplesMs.push(elapsedMs);
        console.info(
          `[MQA-0145] warm_sample=${index + 1}/${WARM_SAMPLE_COUNT} dashboard_ready_ms=${elapsedMs}`,
        );
      }
    } finally {
      await warmContext.close();
    }

    const result = {
      fixture: {
        salonCount: 1,
        staffCount: STAFF_COUNT,
        serviceCount: SERVICE_COUNT,
        bookingCount: BOOKING_COUNT,
      },
      authenticatedRole: "owner",
      environment: "disposable local Supabase + local Next.js dev server",
      coldDefinition: "fresh browser context/cache; persisted authenticated owner storage state; warm server",
      warmDefinition: "full document reload in the same authenticated browser context",
      cold: summarize(coldSamplesMs),
      warm: summarize(warmSamplesMs),
      slaMs: P95_SLA_MS,
    };
    console.info(`[MQA-0145] ${JSON.stringify(result)}`);
    await testInfo.attach("mqa-0145-dashboard-load-latency.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });

    expect(coldSamplesMs).toHaveLength(COLD_SAMPLE_COUNT);
    expect(warmSamplesMs).toHaveLength(WARM_SAMPLE_COUNT);
    expect(result.cold.p95Ms, "cold-browser local dashboard p95").toBeLessThan(
      P95_SLA_MS,
    );
    expect(result.warm.p95Ms, "warm-session local dashboard p95").toBeLessThan(
      P95_SLA_MS,
    );
  });
});

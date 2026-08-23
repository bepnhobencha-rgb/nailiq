import { createHash } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { navigateToConfirmStep } from "./helpers/bookingFlow";
import {
  cleanupClientProfile,
  cleanupTestSalon,
  seedTestSalon,
} from "./helpers/db";

const SLUG = "e2e-booking-confirmation-performance";
const SAMPLE_COUNT = 20;
const P95_SLA_MS = 1_000;
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function percentileNearestRank(samples: readonly number[], percentile: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1]!;
}

async function isolateRateLimitIdentity(page: Page, identity: string) {
  const digest = createHash("sha256").update(identity).digest("hex");
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `2001:db8::${digest.slice(0, 4)}:${digest.slice(4, 8)}`,
  });
}

test.describe("MQA-0144 — committed booking confirmation latency", () => {
  test.beforeAll(async () => {
    await seedTestSalon({
      slug: SLUG,
      name: "E2E Booking Confirmation Performance Salon",
      phone: "15553334444",
    });
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("20 warm sequential confirmations keep local p95 below 1 second", async ({
    browser,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "The controlled local latency distribution is measured once in Chromium",
    );
    test.setTimeout(6 * 60_000);

    const { data: salon, error: salonError } = await db
      .from("salons")
      .select("id")
      .eq("slug", SLUG)
      .single();
    expect(salonError).toBeNull();
    const salonId = salon!.id as string;
    const samplesMs: number[] = [];
    const bookingIds: string[] = [];

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const guestPhone = `16045552${suffix}`;
      const guestName = `Confirmation Perf ${suffix}`;
      const context = await browser.newContext({
        baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
      });
      const page = await context.newPage();

      try {
        await cleanupClientProfile(guestPhone);
        await isolateRateLimitIdentity(page, `${SLUG}:${index}`);
        await navigateToConfirmStep(page, SLUG, {
          name: guestName,
          phone: guestPhone,
        });
        await page.getByTestId("sms-consent").check();

        const confirmButton = page.getByTestId("confirm-booking-btn");
        await expect(confirmButton).toBeEnabled({ timeout: 15_000 });

        const startedAt = performance.now();
        await confirmButton.click();
        await expect(page.getByTestId("booking-success")).toBeVisible({
          timeout: 15_000,
        });
        const elapsedMs = Math.round(performance.now() - startedAt);

        const { data: rows, error: bookingError } = await db
          .from("bookings")
          .select("id, salon_id, client_name, client_phone, status")
          .eq("salon_id", salonId)
          .eq("client_phone", guestPhone);
        expect(bookingError).toBeNull();
        expect(rows).toHaveLength(1);
        expect(rows?.[0]).toMatchObject({
          salon_id: salonId,
          client_name: guestName,
          client_phone: guestPhone,
          status: "confirmed",
        });

        samplesMs.push(elapsedMs);
        bookingIds.push(String(rows![0]!.id));
        console.info(
          `[MQA-0144] sample=${index + 1}/${SAMPLE_COUNT} committed_confirmation_ms=${elapsedMs}`,
        );

        const { error: deleteError } = await db
          .from("bookings")
          .delete()
          .eq("id", rows![0]!.id);
        expect(deleteError).toBeNull();
        await cleanupClientProfile(guestPhone);
      } finally {
        await context.close();
      }
    }

    const p50Ms = percentileNearestRank(samplesMs, 0.5);
    const p95Ms = percentileNearestRank(samplesMs, 0.95);
    const maxMs = Math.max(...samplesMs);
    const result = {
      sampleCount: samplesMs.length,
      concurrency: 1,
      environment: "disposable local Supabase + local Next.js dev server",
      measuredBoundary:
        "enabled confirm click on a resolved quote to visible success after committed booking response",
      samplesMs,
      p50Ms,
      p95Ms,
      maxMs,
      slaMs: P95_SLA_MS,
      bookingIds,
    };
    console.info(`[MQA-0144] ${JSON.stringify(result)}`);
    await testInfo.attach("mqa-0144-booking-confirmation-latency.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });

    expect(samplesMs).toHaveLength(SAMPLE_COUNT);
    expect(p95Ms, "local committed-confirmation p95").toBeLessThan(P95_SLA_MS);

    const { count: residualBookings, error: residualError } = await db
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("salon_id", salonId);
    expect(residualError).toBeNull();
    expect(residualBookings).toBe(0);
  });
});

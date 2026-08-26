import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { navigateToConfirmStep } from "./helpers/bookingFlow";
import {
  cleanupClientProfile,
  cleanupTestSalon,
  seedTestSalon,
} from "./helpers/db";

const SLUG = "e2e-mqa-0209-poor-network";
const GUEST_PHONE = "16045552009";
const GUEST_NAME = "Poor Network Guest";
const ALWAYS_OPEN = {
  mon: { open: "00:00", close: "23:59", closed: false },
  tue: { open: "00:00", close: "23:59", closed: false },
  wed: { open: "00:00", close: "23:59", closed: false },
  thu: { open: "00:00", close: "23:59", closed: false },
  fri: { open: "00:00", close: "23:59", closed: false },
  sat: { open: "00:00", close: "23:59", closed: false },
  sun: { open: "00:00", close: "23:59", closed: false },
};
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

test.describe("MQA-0209 — customer booking under poor internet", () => {
  test.beforeAll(async () => {
    await cleanupClientProfile(GUEST_PHONE);
    const fixture = await seedTestSalon({
      slug: SLUG,
      name: "E2E Poor Network Replay Salon",
      phone: "15553202009",
    });
    const { error } = await db
      .from("salons")
      .update({ timezone: "UTC", opening_hours: ALWAYS_OPEN })
      .eq("id", fixture.salonId);
    if (error) throw new Error(`configure poor-network fixture: ${error.message}`);
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
    await cleanupClientProfile(GUEST_PHONE);
  });

  test("a lost committed response replays the same request and creates exactly one booking", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile",
      "The poor-network customer journey is measured in the iPhone WebKit profile",
    );
    test.setTimeout(2 * 60_000);

    const digest = createHash("sha256").update(`${SLUG}:mobile`).digest("hex");
    await page.setExtraHTTPHeaders({
      "x-forwarded-for": `2001:db8::${digest.slice(0, 4)}:${digest.slice(4, 8)}`,
    });

    const requestIds: string[] = [];
    let createAttempts = 0;
    await page.route("**/rest/v1/rpc/create_public_booking", async (route) => {
      createAttempts += 1;
      const body = route.request().postDataJSON() as { p_idempotency_key?: unknown };
      requestIds.push(String(body.p_idempotency_key ?? ""));

      if (createAttempts === 1) {
        const committedResponse = await route.fetch();
        expect(committedResponse.ok()).toBe(true);
        // Hold the already-committed response beyond the product's 12-second
        // boundary. The browser sees an unknown outcome while PostgreSQL keeps
        // the durable row, exactly modeling response loss on poor internet.
        await new Promise((resolve) => setTimeout(resolve, 13_000));
        await route.fulfill({ response: committedResponse }).catch(() => undefined);
        return;
      }

      await route.continue();
    });

    await navigateToConfirmStep(page, SLUG, {
      name: GUEST_NAME,
      phone: GUEST_PHONE,
    });
    await page.getByTestId("sms-consent").check();
    const confirm = page.getByTestId("confirm-booking-btn");
    await expect(confirm).toBeEnabled();

    const firstStartedAt = performance.now();
    await confirm.click();
    await expect(
      page.getByRole("alert").filter({
        hasText: "NailIQ won't create a duplicate",
      }),
    ).toBeVisible({ timeout: 20_000 });
    const unknownOutcomeMs = Math.round(performance.now() - firstStartedAt);

    const { data: salon, error: salonError } = await db
      .from("salons")
      .select("id")
      .eq("slug", SLUG)
      .single();
    expect(salonError).toBeNull();
    const { data: committedRows, error: committedError } = await db
      .from("bookings")
      .select("id,idempotency_key,status")
      .eq("salon_id", salon!.id)
      .eq("client_phone", GUEST_PHONE);
    expect(committedError).toBeNull();
    expect(committedRows).toHaveLength(1);
    expect(committedRows?.[0]?.status).toBe("confirmed");

    const replayStartedAt = performance.now();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByTestId("booking-success")).toBeVisible({ timeout: 20_000 });
    const replayRecoveryMs = Math.round(performance.now() - replayStartedAt);

    const { data: finalRows, error: finalError } = await db
      .from("bookings")
      .select("id,idempotency_key,status")
      .eq("salon_id", salon!.id)
      .eq("client_phone", GUEST_PHONE);
    expect(finalError).toBeNull();
    expect(finalRows).toHaveLength(1);
    expect(finalRows?.[0]?.id).toBe(committedRows?.[0]?.id);
    expect(createAttempts).toBe(2);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(requestIds[1]).toBe(requestIds[0]);
    expect(finalRows?.[0]?.idempotency_key).toBe(requestIds[0]);

    const result = {
      deviceProfile: testInfo.project.name,
      transportModel: "first create response held for 13 seconds after database commit",
      productUnknownBoundaryMs: 12_000,
      unknownOutcomeVisibleMs: unknownOutcomeMs,
      replayRecoveryMs,
      createAttempts,
      stableRequestId: requestIds[0] === requestIds[1],
      committedRowsBeforeReplay: committedRows?.length ?? 0,
      rowsAfterReplay: finalRows?.length ?? 0,
      duplicateRows: Math.max(0, (finalRows?.length ?? 0) - 1),
    };
    console.info(`[MQA-0209] ${JSON.stringify(result)}`);
    await testInfo.attach("mqa-0209-poor-network-replay.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
  });
});

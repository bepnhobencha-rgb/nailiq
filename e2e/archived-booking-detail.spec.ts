import { expect, test } from "@playwright/test";

import { cleanupTestSalon, seedTestSalon } from "./helpers/db";
import { createServiceRoleClient } from "../src/shared/lib/supabase/serviceRole";
import { buildOwnerRescheduleTimePayload } from "../src/shared/dashboard/ownerBookingNotificationCopy";
import {
  salonDateOffset,
  salonWallTimeToUtcIso,
} from "../src/shared/lib/salonTime";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const SLUG = "e2e-archived-booking-detail";

function canonicalIso(value: string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

test.describe("Archived booking detail — read-only history", () => {
  let salonId: string;

  test.beforeAll(async () => {
    const seeded = await seedTestSalon({
      slug: SLUG,
      name: "E2E Archived Booking Salon",
      phone: "16045551880",
      feature_flags: { archived_booking_recovery_enabled: false },
    });
    salonId = seeded.salonId;

    const db = createServiceRoleClient();
    const [{ data: service }, { data: staff }] = await Promise.all([
      db
        .from("services")
        .select("id")
        .eq("salon_id", salonId)
        .limit(1)
        .single(),
      db
        .from("staff")
        .select("id")
        .eq("salon_id", salonId)
        .limit(1)
        .single(),
    ]);

    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    start.setUTCHours(17, 0, 0, 0);
    const shared = {
      salon_id: salonId,
      service_id: service!.id,
      staff_id: staff!.id,
      start_time_utc: start.toISOString(),
      end_time_utc: new Date(start.getTime() + 45 * 60 * 1000).toISOString(),
      source: "appointment",
      booking_channel: "desk",
      price_cents: 4500,
    };

    const { error } = await db.from("bookings").insert([
      {
        ...shared,
        client_name: "Archived Cancelled Guest",
        client_phone: "16045551881",
        status: "cancelled",
      },
      {
        ...shared,
        client_name: "Archived No Show Guest",
        client_phone: "16045551882",
        status: "no_show",
        noshow_fee_cents: 1700,
        noshow_charge_status: "waived",
      },
    ]);
    if (error) throw new Error(error.message);
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test.beforeEach(async ({ page }) => {
    await page.context().addCookies([
      { name: "nailiq-demo-slug", value: SLUG, url: BASE_URL },
    ]);
    await page.goto(`/dashboard/${SLUG}/activity`);
    await expect(
      page.getByRole("heading", { name: "Nhật ký hoạt động" }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("owner can inspect cancelled history while recovery stays off", async ({
    page,
  }) => {
    await page.getByTestId("activity-tab-cancelled").click();
    await page
      .getByTestId("activity-open-archived-booking")
      .filter({ hasText: "Archived Cancelled Guest" })
      .click();

    const detail = page.getByTestId("archived-booking-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Archived Cancelled Guest");
    await expect(detail).toContainText("Đã huỷ");
    await expect(detail).not.toContainText("16045551881");
    await expect(page.getByTestId("archived-booking-recover")).toHaveCount(0);
  });

  test("owner can inspect no-show fee outcome without reopening it", async ({
    page,
  }) => {
    await page.getByTestId("activity-tab-no_show").click();
    await page
      .getByTestId("activity-open-archived-booking")
      .filter({ hasText: "Archived No Show Guest" })
      .click();

    const detail = page.getByTestId("archived-booking-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Archived No Show Guest");
    await expect(detail).toContainText("Không đến");
    await expect(detail).toContainText("$17.00");
    await expect(detail).toContainText("Đã miễn phí");
    await expect(page.getByTestId("archived-booking-recover")).toHaveCount(0);
  });
});

const MUTATION_SLUG = "e2e-booking-mutation-audit";
const MUTATION_TIMEZONE = "America/Vancouver";

function nextOpenSalonDateYmd(daysOut: number): string {
  for (let offset = daysOut; offset < daysOut + 7; offset += 1) {
    const dateYmd = salonDateOffset(MUTATION_TIMEZONE, offset);
    const [year, month, day] = dateYmd.split("-").map(Number);
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() !== 0) {
      return dateYmd;
    }
  }
  throw new Error("mutation audit fixture could not find an open salon day");
}

test.describe("Booking mutation audit — reschedule and cancel", () => {
  let salonId: string;
  let serviceId: string;
  let staffId: string;

  test.beforeEach(async () => {
    const seeded = await seedTestSalon({
      slug: MUTATION_SLUG,
      name: "E2E Booking Mutation Audit Salon",
      phone: "16045551890",
    });
    salonId = seeded.salonId;

    const db = createServiceRoleClient();
    const [{ data: service }, { data: staff }] = await Promise.all([
      db
        .from("services")
        .select("id")
        .eq("salon_id", salonId)
        .limit(1)
        .single(),
      db
        .from("staff")
        .select("id")
        .eq("salon_id", salonId)
        .limit(1)
        .single(),
    ]);
    serviceId = String(service?.id ?? "");
    staffId = String(staff?.id ?? "");
    if (!serviceId || !staffId) {
      throw new Error("mutation audit fixture is missing service/staff");
    }
    await db
      .from("salons")
      .update({ timezone: MUTATION_TIMEZONE })
      .eq("id", salonId);
  });

  test.afterEach(async () => {
    await cleanupTestSalon(MUTATION_SLUG);
  });

  async function seedBookingWithToken(clientName: string) {
    const db = createServiceRoleClient();
    const startIso = salonWallTimeToUtcIso(
      nextOpenSalonDateYmd(3),
      10 * 60,
      MUTATION_TIMEZONE,
    );
    const startMs = Date.parse(startIso);
    const { data: booking, error: bookingError } = await db
      .from("bookings")
      .insert({
        salon_id: salonId,
        service_id: serviceId,
        staff_id: staffId,
        client_name: clientName,
        client_phone: "16045551891",
        start_time_utc: startIso,
        end_time_utc: new Date(startMs + 55 * 60 * 1000).toISOString(),
        status: "confirmed",
        source: "appointment",
        booking_channel: "online",
      })
      .select("id")
      .single();
    if (bookingError || !booking?.id) {
      throw new Error(bookingError?.message ?? "booking seed failed");
    }

    const { data: token, error: tokenError } = await db
      .from("booking_reminder_tokens" as never)
      .insert({
        booking_id: booking.id,
        salon_id: salonId,
        expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      })
      .select("id")
      .single();
    const tokenId = (token as unknown as { id?: string } | null)?.id;
    if (tokenError || !tokenId) {
      throw new Error(tokenError?.message ?? "token seed failed");
    }
    return {
      bookingId: String(booking.id),
      tokenId,
      originalStart: startIso,
    };
  }

  test("customer reschedule persists old/new times and auditable email labels", async ({
    page,
  }) => {
    const fixture = await seedBookingWithToken("Mutation Reschedule Guest");
    const targetYmd = nextOpenSalonDateYmd(6);
    const expectedNewStart = salonWallTimeToUtcIso(
      targetYmd,
      14 * 60,
      MUTATION_TIMEZONE,
    );

    const response = await page.request.post("/api/booking/reschedule-action", {
      data: {
        token: fixture.tokenId,
        date: targetYmd,
        slotLabel: "2:00 PM",
      },
    });
    const body = (await response.json()) as { ok?: boolean; code?: string };
    expect(response.ok(), JSON.stringify(body)).toBe(true);
    expect(body.ok, JSON.stringify(body)).toBe(true);

    const db = createServiceRoleClient();
    await expect
      .poll(async () => {
        const { data } = await db
          .from("bookings")
          .select(
            "start_time_utc, rescheduled_from_time_utc, rescheduled_at, rescheduled_by",
          )
          .eq("id", fixture.bookingId)
          .single();
        return data
          ? {
              ...data,
              start_time_utc: canonicalIso(data.start_time_utc),
              rescheduled_from_time_utc: canonicalIso(
                data.rescheduled_from_time_utc,
              ),
            }
          : data;
      })
      .toMatchObject({
        start_time_utc: expectedNewStart,
        rescheduled_from_time_utc: fixture.originalStart,
        rescheduled_by: "customer",
      });

    const { data: updated } = await db
      .from("bookings")
      .select("start_time_utc, rescheduled_from_time_utc, rescheduled_at")
      .eq("id", fixture.bookingId)
      .single();
    expect(updated?.rescheduled_at).toBeTruthy();

    await expect
      .poll(async () => {
        const { data } = await db
          .from("booking_events")
          .select("actor_role, event_type, payload, created_at")
          .eq("booking_id", fixture.bookingId)
          .eq("event_type", "booking_rescheduled")
          .maybeSingle();
        if (!data) return data;
        const payload = data.payload as Record<string, unknown> | null;
        return {
          ...data,
          payload: payload
            ? {
                ...payload,
                previous_start_utc: canonicalIso(
                  String(payload.previous_start_utc ?? ""),
                ),
                new_start_utc: canonicalIso(
                  String(payload.new_start_utc ?? ""),
                ),
              }
            : payload,
        };
      })
      .toMatchObject({
        actor_role: "public_guest",
        event_type: "booking_rescheduled",
        payload: {
          reason: "customer_email_link",
          previous_start_utc: fixture.originalStart,
          new_start_utc: expectedNewStart,
        },
      });

    const notificationPayload = buildOwnerRescheduleTimePayload({
      previousStartUtc: String(updated?.rescheduled_from_time_utc ?? ""),
      nextStartUtc: String(updated?.start_time_utc ?? ""),
      timezone: MUTATION_TIMEZONE,
      durationMin: 55,
    });
    expect(notificationPayload).toMatchObject({
      event: "reschedule",
      timezone: MUTATION_TIMEZONE,
      previousStartUtc: fixture.originalStart,
      nextStartUtc: expectedNewStart,
      before: expect.stringContaining("10:00 AM"),
      afterTime: "2:00 PM · 55 min",
    });
    expect(notificationPayload.textLines[0]).toContain("Before / Trước khi đổi");
    expect(notificationPayload.textLines[1]).toContain("After / Sau khi đổi");
  });

  test("customer cancel persists actor, timestamp and reason without a charge", async ({
    page,
  }) => {
    const fixture = await seedBookingWithToken("Mutation Cancel Guest");

    const response = await page.request.post("/api/booking/cancel-action", {
      data: { token: fixture.tokenId },
    });
    const body = (await response.json()) as {
      ok?: boolean;
      feeCharged?: boolean;
      feeCents?: number;
      code?: string;
    };
    expect(response.ok(), JSON.stringify(body)).toBe(true);
    expect(body).toMatchObject({ ok: true, feeCharged: false, feeCents: 0 });

    const db = createServiceRoleClient();
    await expect
      .poll(async () => {
        const [{ data: booking }, { data: token }, { data: event }] =
          await Promise.all([
            db
              .from("bookings")
              .select("status")
              .eq("id", fixture.bookingId)
              .single(),
            db
              .from("booking_reminder_tokens" as never)
              .select("used_at, used_action")
              .eq("id", fixture.tokenId)
              .single(),
            db
              .from("booking_events")
              .select("actor_role, event_type, payload, created_at")
              .eq("booking_id", fixture.bookingId)
              .eq("event_type", "booking_cancelled")
              .maybeSingle(),
          ]);
        return { booking, token, event };
      })
      .toMatchObject({
        booking: { status: "cancelled" },
        token: { used_action: "cancel" },
        event: {
          actor_role: "public_guest",
          event_type: "booking_cancelled",
          payload: {
            reason: "customer_email_link",
            fee_decision: "not_applicable",
            fee_cents: 0,
          },
        },
      });
  });
});

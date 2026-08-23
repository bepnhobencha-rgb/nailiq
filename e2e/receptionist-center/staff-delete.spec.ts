import { createHash } from "node:crypto";

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalonMember,
} from "../helpers/db";
import { DEFAULT_OPENING_HOURS_JSON } from "@/shared/dashboard/openingHoursDefaults";

import { seedDeskBooking, supabaseAdmin } from "./helpers";

// Append GITHUB_RUN_ID (or a local fallback) so parallel CI runs on different
// PRs each get their own salon and cannot stomp each other's fixtures.
const _RUN_SUFFIX =
  process.env.GITHUB_RUN_ID ??
  process.env.PLAYWRIGHT_WORKER_INDEX ??
  String(Date.now()).slice(-6);

/** Run-scoped slug; torn down in afterAll. */
const E2E_STAFF_DELETE_SLUG = `e2e-staff-delete-${_RUN_SUFFIX}`;
const ANCHOR_NAME = "E2E_ST_ANCHOR";
const NAME_BLOCK = "E2E_ST_BLOCK";
const NAME_OK = "E2E_ST_OK";

type Fixture = {
  salonId: string;
  slug: string;
  serviceId: string;
  anchorStaffId: string;
};

function tomorrowYmdUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function yesterdayYmdUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function isoAtUtcYmdHourMinute(
  ymd: string,
  hour: number,
  minute: number,
): string {
  const [y, m, dd] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd, hour, minute, 0)).toISOString();
}

/**
 * The safe-offboarding button for a given staff id. Rows are scoped by the stable
 * `data-testid="staff-delete-<id>"` on the icon button — the panel renders
 * compact rows (drawer-based edit), not inline-editable `<li>` inputs.
 */
function staffDeleteBtn(page: Page, staffId: string) {
  return page.getByTestId(`staff-delete-${staffId}`);
}

async function gotoSetupStaff(
  page: Page,
  slug: string,
  account: { email: string; password: string },
): Promise<void> {
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
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
  await page.goto(`/dashboard/${encodeURIComponent(slug)}/setup/staff`);
  await page.getByRole("heading", { name: "Staff", exact: false }).first().waitFor({
    timeout: 45_000,
  });
}

async function seedSalonAnchorAndService(): Promise<Fixture> {
  await cleanupTestSalon(E2E_STAFF_DELETE_SLUG);

  const openingParsed: unknown = JSON.parse(DEFAULT_OPENING_HOURS_JSON);

  const { data: salon, error: salonErr } = await supabaseAdmin
    .from("salons")
    .insert({
      slug: E2E_STAFF_DELETE_SLUG,
      name: "E2E Staff Delete Salon",
      phone: "15558889999",
      profile_complete: true,
      timezone: "UTC",
      opening_hours: openingParsed,
      setup_wizard_completed_at: new Date().toISOString(),
      // This browser E2E proves durable queue state plus zero recorded attempt
      // at the action boundary. Provider-call trapping belongs to the worker
      // unit test; this test never starts that worker.
      email_outbound_enabled: true,
    })
    .select("id")
    .single();

  if (salonErr || !salon?.id) {
    throw new Error(salonErr?.message ?? "seedSalon: salon insert failed");
  }

  const salonId = salon.id as string;

  const { data: staffRowInsert, error: staffErr } = await supabaseAdmin
    .from("staff")
    .insert({
      salon_id: salonId,
      name: ANCHOR_NAME,
      job_role: "nail_tech",
    })
    .select("id")
    .single();

  if (staffErr || !staffRowInsert?.id) {
    await supabaseAdmin.from("salons").delete().eq("id", salonId);
    throw new Error(staffErr?.message ?? "seedSalon: anchor staff insert failed");
  }

  const { data: svc, error: svcErr } = await supabaseAdmin
    .from("services")
    .insert({
      salon_id: salonId,
      name: "E2E_ST_Service",
      price_cents: 3000,
      duration_minutes: 30,
      buffer_minutes: 5,
    })
    .select("id")
    .single();

  if (svcErr || !svc?.id) {
    await supabaseAdmin.from("salons").delete().eq("id", salonId);
    throw new Error(svcErr?.message ?? "seedSalon: service insert failed");
  }

  return {
    salonId,
    slug: E2E_STAFF_DELETE_SLUG,
    serviceId: svc.id as string,
    anchorStaffId: staffRowInsert.id as string,
  };
}

async function resetEphemeralStaffAndBookings(salonId: string): Promise<void> {
  const { error: bErr } = await supabaseAdmin
    .from("bookings")
    .delete()
    .eq("salon_id", salonId);
  if (bErr) throw new Error(bErr.message);

  const { error: sErr } = await supabaseAdmin
    .from("staff")
    .delete()
    .eq("salon_id", salonId)
    .in("name", [NAME_BLOCK, NAME_OK]);
  if (sErr) throw new Error(sErr.message);
}

let fx: Fixture;
let owner: Awaited<ReturnType<typeof seedTestSalonMember>>;

test.beforeAll(async () => {
  fx = await seedSalonAnchorAndService();
  owner = await seedTestSalonMember(fx.salonId, "owner");
});

test.beforeEach(async () => {
  await resetEphemeralStaffAndBookings(fx.salonId);
  const { error } = await supabaseAdmin
    .from("salons")
    .update({ email_outbound_enabled: true })
    .eq("id", fx.salonId);
  if (error) throw new Error(error.message);
});

test.afterAll(async () => {
  await cleanupTestSalon(E2E_STAFF_DELETE_SLUG);
  await cleanupTestUser(owner.userId);
});

test.describe("Safe staff offboarding", () => {
  test.describe.configure({ timeout: 60_000 });

  test("st-1: atomically reassigns and queues with zero recorded provider attempt", async ({ page }) => {
    const { data: blockStaff, error: insErr } = await supabaseAdmin
      .from("staff")
      .insert({
        salon_id: fx.salonId,
        name: NAME_BLOCK,
        job_role: "nail_tech",
      })
      .select("id")
      .single();

    if (insErr || !blockStaff?.id) {
      throw new Error(insErr?.message ?? "st-1: staff insert failed");
    }

    const blockId = blockStaff.id as string;
    const ymd = tomorrowYmdUtc();
    const futureBookingId = await seedDeskBooking(fx.salonId, {
      clientName: "E2E_ST_BOOK_FUTURE",
      serviceId: fx.serviceId,
      staffId: blockId,
      startIso: isoAtUtcYmdHourMinute(ymd, 14, 0),
      endIso: isoAtUtcYmdHourMinute(ymd, 14, 45),
      status: "pending",
      source: "appointment",
    });
    const { error: contactError } = await supabaseAdmin
      .from("bookings")
      .update({ client_email: "mqa0201@example.test" })
      .eq("id", futureBookingId)
      .eq("salon_id", fx.salonId);
    if (contactError) throw new Error(contactError.message);

    await gotoSetupStaff(page, fx.slug, owner);

    await staffDeleteBtn(page, blockId).click();
    await expect(page.getByRole("heading", { name: /Offboard staff member|Cho nhân viên nghỉ việc/i })).toBeVisible();
    await expect(page.getByTestId("staff-offboarding-complete")).toBeEnabled();
    const requestStorageKey = `nailiq:staff-offboarding-request:${fx.slug}:${blockId}`;
    const firstRequestId = await page.evaluate((key) =>
      window.sessionStorage.getItem(key), requestStorageKey);
    expect(firstRequestId).toMatch(/^[0-9a-f-]{36}$/i);
    await page.getByRole("button", { name: /Not now|Để sau/i }).click();
    await staffDeleteBtn(page, blockId).click();
    await expect(page.getByTestId("staff-offboarding-complete")).toBeEnabled();
    await expect.poll(() => page.evaluate((key) =>
      window.sessionStorage.getItem(key), requestStorageKey)).toBe(firstRequestId);
    await page.reload();
    await staffDeleteBtn(page, blockId).click();
    await expect(page.getByTestId("staff-offboarding-complete")).toBeEnabled();
    await expect.poll(() => page.evaluate((key) =>
      window.sessionStorage.getItem(key), requestStorageKey)).toBe(firstRequestId);
    await page.getByLabel(/Email · 1 guest/i).check();
    await page.getByTestId("staff-offboarding-complete").click();

    await expect(
      page
        .getByRole("status")
        .filter({
          hasText:
            /1 notice event\(s\) \/ 1 channel delivery\(s\) queued; no provider attempt was recorded at this action boundary/i,
        }),
    ).toBeVisible();

    const { data: queuedOutbox, error: queuedOutboxError } = await supabaseAdmin
      .from("staff_action_notification_outbox")
      .select("id,event_type,status,requested_channels")
      .eq("salon_id", fx.salonId)
      .eq("booking_id", futureBookingId)
      .eq("event_type", "staff_change")
      .single();
    if (queuedOutboxError || !queuedOutbox?.id) {
      throw new Error(
        queuedOutboxError?.message ?? "st-1: durable staff-change outbox missing",
      );
    }
    expect(queuedOutbox).toMatchObject({
      event_type: "staff_change",
      status: "active",
      requested_channels: { sms: false, email: true },
    });
    const { data: queuedDelivery, error: queuedDeliveryError } = await supabaseAdmin
      .from("staff_action_notification_deliveries")
      .select("channel,status,attempt_count,provider_message_id")
      .eq("outbox_id", queuedOutbox.id)
      .single();
    if (queuedDeliveryError) throw new Error(queuedDeliveryError.message);
    expect(queuedDelivery).toEqual({
      channel: "email",
      status: "awaiting_material",
      attempt_count: 0,
      provider_message_id: null,
    });
    const { count: auditCount, error: auditError } = await supabaseAdmin
      .from("booking_events")
      .select("id", { count: "exact", head: true })
      .eq("booking_id", futureBookingId)
      .eq("staff_offboarding_request_id", firstRequestId!);
    if (auditError) throw new Error(auditError.message);
    expect(auditCount).toBe(1);
    await expect.poll(() => page.evaluate((key) =>
      window.sessionStorage.getItem(key), requestStorageKey)).toBeNull();

    await expect
      .poll(async () => {
        const { data } = await supabaseAdmin
          .from("bookings")
          .select("staff_id")
          .eq("salon_id", fx.salonId)
          .eq("client_name", "E2E_ST_BOOK_FUTURE")
          .single();
        return data?.staff_id;
      })
      .toBe(fx.anchorStaffId);
    const { data: staffAfter } = await supabaseAdmin
      .from("staff")
      .select("status,deleted_at")
      .eq("id", blockId)
      .single();
    expect(staffAfter?.status).toBe("inactive");
    expect(staffAfter?.deleted_at).toBeNull();
  });

  test("st-1b: disabled email is unavailable and queues no durable delivery", async ({ page }) => {
    const { data: staffRow, error: staffError } = await supabaseAdmin
      .from("staff")
      .insert({ salon_id: fx.salonId, name: NAME_BLOCK, job_role: "nail_tech" })
      .select("id")
      .single();
    if (staffError || !staffRow?.id) {
      throw new Error(staffError?.message ?? "st-1b: staff insert failed");
    }
    const staffId = staffRow.id as string;
    const ymd = tomorrowYmdUtc();
    const bookingId = await seedDeskBooking(fx.salonId, {
      clientName: "E2E_ST_DISABLED_CHANNEL",
      serviceId: fx.serviceId,
      staffId,
      startIso: isoAtUtcYmdHourMinute(ymd, 16, 0),
      endIso: isoAtUtcYmdHourMinute(ymd, 16, 45),
      status: "pending",
      source: "appointment",
    });
    const { error: bookingError } = await supabaseAdmin
      .from("bookings")
      .update({ client_email: "disabled-channel@example.test" })
      .eq("id", bookingId);
    if (bookingError) throw new Error(bookingError.message);
    const { error: channelError } = await supabaseAdmin
      .from("salons")
      .update({ email_outbound_enabled: false })
      .eq("id", fx.salonId);
    if (channelError) throw new Error(channelError.message);

    await gotoSetupStaff(page, fx.slug, owner);
    await staffDeleteBtn(page, staffId).click();
    await expect(page.getByTestId("staff-offboarding-notify-email")).toBeDisabled();
    await expect(page.getByTestId("staff-offboarding-channel-warning"))
      .toContainText(/Email/);
    await expect(page.getByTestId("staff-offboarding-complete")).toBeEnabled();
    await page.getByTestId("staff-offboarding-complete").click();

    await expect.poll(async () => {
      const { data } = await supabaseAdmin
        .from("staff")
        .select("status")
        .eq("id", staffId)
        .single();
      return data?.status;
    }).toBe("inactive");
    await expect.poll(async () => {
      const { data } = await supabaseAdmin
        .from("bookings")
        .select("staff_id")
        .eq("id", bookingId)
        .single();
      return data?.staff_id;
    }).toBe(fx.anchorStaffId);
    await expect.poll(async () => {
      const { count } = await supabaseAdmin
        .from("staff_action_notification_outbox")
        .select("id", { count: "exact", head: true })
        .eq("booking_id", bookingId)
        .eq("event_type", "staff_change");
      return count;
    }).toBe(0);
  });

  test("st-2: preserves completed appointment attribution", async ({
    page,
  }) => {
    const { data: okStaff, error: insErr } = await supabaseAdmin
      .from("staff")
      .insert({
        salon_id: fx.salonId,
        name: NAME_OK,
        job_role: "nail_tech",
      })
      .select("id")
      .single();

    if (insErr || !okStaff?.id) {
      throw new Error(insErr?.message ?? "st-2: staff insert failed");
    }

    const okId = okStaff.id as string;
    const ymd = yesterdayYmdUtc();
    const bookingId = await seedDeskBooking(fx.salonId, {
      clientName: "E2E_ST_BOOK_PAST",
      serviceId: fx.serviceId,
      staffId: okId,
      startIso: isoAtUtcYmdHourMinute(ymd, 11, 0),
      endIso: isoAtUtcYmdHourMinute(ymd, 11, 45),
      status: "completed",
      source: "appointment",
    });

    await gotoSetupStaff(page, fx.slug, owner);

    await staffDeleteBtn(page, okId).click();
    await expect(page.getByTestId("staff-offboarding-complete")).toBeEnabled();
    await page.getByTestId("staff-offboarding-complete").click();

    await expect
      .poll(async () => {
        const { data } = await supabaseAdmin
          .from("staff")
          .select("status")
          .eq("id", okId)
          .single();
        return data?.status;
      })
      .toBe("inactive");

    const { data: bookingRow, error: bErr } = await supabaseAdmin
      .from("bookings")
      .select("id,status,staff_id")
      .eq("salon_id", fx.salonId)
      .eq("id", bookingId)
      .maybeSingle();

    if (bErr) throw new Error(bErr.message);
    expect(bookingRow?.id).toBe(bookingId);
    expect(bookingRow?.status).toBe("completed");
    expect(bookingRow?.staff_id).toBe(okId);

    const { data: staffAfter } = await supabaseAdmin
      .from("staff")
      .select("status,deleted_at")
      .eq("id", okId)
      .single();
    expect(staffAfter?.status).toBe("inactive");
    expect(staffAfter?.deleted_at).toBeNull();
  });
});

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalon,
  seedTestSalonMember,
} from "../helpers/db";
import { waitForReceptionistHydration } from "../helpers/receptionistHydration";
import { clickWalkinSubmit, supabaseAdmin } from "./helpers";

const RUN_SUFFIX =
  process.env.GITHUB_RUN_ID ??
  process.env.PLAYWRIGHT_WORKER_INDEX ??
  String(Date.now()).slice(-6);

type Account = Awaited<ReturnType<typeof seedTestSalonMember>>;

type Fixture = {
  slug: string;
  otherSlug: string;
  salonId: string;
  serviceId: string;
  staffId: string;
  cancelledId: string;
  noShowId: string;
  admin: Account;
  receptionist: Account;
  otherAdmin: Account;
};

type SourceSnapshot = {
  id: string;
  status: string;
  salon_id: string;
  source: string;
  service_id: string | null;
  staff_id: string | null;
  client_name: string;
  client_phone: string | null;
  client_email: string | null;
  client_notes: string | null;
  start_time_utc: string | null;
  end_time_utc: string | null;
  price_cents: number | null;
  deleted_at: string | null;
};

let fx: Fixture;
let cancelledSnapshot: SourceSnapshot;
let noShowSnapshot: SourceSnapshot;

function fixtureSlug(project: string, suffix: string): string {
  const device = project === "mobile" ? "mob" : "dsk";
  return `e2e-archive-${device}-${suffix}-${RUN_SUFFIX}`;
}

async function loginAs(page: Page, account: Account): Promise<void> {
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
    { timeout: 30_000 },
  );
  await page.locator('input[inputmode="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
}

async function openCenter(page: Page, slug: string): Promise<void> {
  await page.goto(`/dashboard/${encodeURIComponent(slug)}/center`);
  await page
    .getByTestId("receptionist-center-loaded")
    .first()
    .waitFor({ state: "attached", timeout: 45_000 });
  await waitForReceptionistHydration(page, slug);
}

async function loadSourceSnapshot(bookingId: string): Promise<SourceSnapshot> {
  const { data, error } = await supabaseAdmin
    .from("bookings")
    .select(
      "id, status, salon_id, source, service_id, staff_id, client_name, client_phone, client_email, client_notes, start_time_utc, end_time_utc, price_cents, deleted_at",
    )
    .eq("id", bookingId)
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? `booking ${bookingId} not found`);
  }
  return data as SourceSnapshot;
}

async function findServerActionId(exportedName: string): Promise<string> {
  const manifestPath = resolve(
    process.cwd(),
    ".next/server/app/dashboard/[slug]/center/page/server-reference-manifest.json",
  );

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          node?: Record<string, { exportedName?: string }>;
        };
        const found = Object.entries(parsed.node ?? {}).find(
          ([, entry]) => entry.exportedName === exportedName,
        );
        if (found) return found[0];
      } catch {
        // The dev compiler writes this file atomically in normal operation,
        // but tolerate a partially-written manifest during a hot rebuild.
      }
    }
    await new Promise((done) => setTimeout(done, 200));
  }

  throw new Error(`server action ${exportedName} was not compiled for Center`);
}

async function invokeServerAction(
  page: Page,
  exportedName: string,
  args: unknown[],
): Promise<string> {
  const actionId = await findServerActionId(exportedName);
  const appHistory = await page.evaluate(() => {
    return (
      window.history.state as {
        __PRIVATE_NEXTJS_INTERNALS_TREE?: {
          tree?: unknown;
        };
      } | null
    )?.__PRIVATE_NEXTJS_INTERNALS_TREE;
  });
  if (!appHistory?.tree) {
    throw new Error("Next.js router tree is unavailable for server action");
  }

  const target = new URL(page.url());
  const response = await page.context().request.post(target.toString(), {
    headers: {
      Accept: "text/x-component",
      "Content-Type": "text/plain;charset=UTF-8",
      "Next-Action": actionId,
      "Next-Router-State-Tree": encodeURIComponent(
        JSON.stringify(appHistory.tree),
      ),
      "Next-Url": target.pathname,
      Origin: target.origin,
    },
    data: JSON.stringify(args),
  });
  const body = await response.text();
  expect(response.ok(), `${exportedName}: ${body}`).toBe(true);
  return body;
}

async function seedTerminalBooking(input: {
  status: "cancelled" | "no_show";
  clientName: string;
  clientPhone: string;
  start: Date;
  noShowFeeCents?: number;
}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("bookings")
    .insert({
      salon_id: fx.salonId,
      service_id: fx.serviceId,
      staff_id: fx.staffId,
      client_name: input.clientName,
      client_phone: input.clientPhone,
      client_email: `${input.status}@nailiq.test.invalid`,
      client_notes: `immutable ${input.status} source`,
      start_time_utc: input.start.toISOString(),
      end_time_utc: new Date(input.start.getTime() + 45 * 60_000).toISOString(),
      status: input.status,
      source: "appointment",
      booking_channel: "desk",
      price_cents: 4500,
      ...(input.noShowFeeCents
        ? {
            noshow_fee_cents: input.noShowFeeCents,
            noshow_charge_status: "waived",
          }
        : {}),
    })
    .select("id")
    .single();
  if (error || !data?.id) {
    throw new Error(error?.message ?? `failed to seed ${input.status}`);
  }
  return String(data.id);
}

async function childCount(): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", fx.salonId)
    .eq("recovered_from_booking_id" as never, fx.noShowId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

test.describe.serial("Authenticated archived booking terminal recovery", () => {
  test.beforeAll(async ({}, testInfo) => {
    const slug = fixtureSlug(testInfo.project.name, "main");
    const otherSlug = fixtureSlug(testInfo.project.name, "other");
    const salon = await seedTestSalon({
      slug,
      name: "E2E Archive Recovery Salon",
      phone: "16045550160",
      feature_flags: { archived_booking_recovery_enabled: true },
    });
    const otherSalon = await seedTestSalon({
      slug: otherSlug,
      name: "E2E Other Tenant Salon",
      phone: "16045550161",
    });

    const [{ data: service }, { data: staff }] = await Promise.all([
      supabaseAdmin
        .from("services")
        .select("id")
        .eq("salon_id", salon.salonId)
        .limit(1)
        .single(),
      supabaseAdmin
        .from("staff")
        .select("id")
        .eq("salon_id", salon.salonId)
        .limit(1)
        .single(),
    ]);
    if (!service?.id || !staff?.id) {
      throw new Error("archive fixture is missing service/staff");
    }

    fx = {
      slug,
      otherSlug,
      salonId: salon.salonId,
      serviceId: String(service.id),
      staffId: String(staff.id),
      cancelledId: "",
      noShowId: "",
      admin: await seedTestSalonMember(salon.salonId, "admin"),
      receptionist: await seedTestSalonMember(salon.salonId, "receptionist"),
      otherAdmin: await seedTestSalonMember(otherSalon.salonId, "admin"),
    };

    const future = new Date(Date.now() + 48 * 60 * 60_000);
    future.setUTCMinutes(0, 0, 0);
    const past = new Date(Date.now() - 45 * 60_000);
    fx.cancelledId = await seedTerminalBooking({
      status: "cancelled",
      clientName: "Archive Cancelled Guest",
      clientPhone: "16045550162",
      start: future,
    });
    fx.noShowId = await seedTerminalBooking({
      status: "no_show",
      clientName: "Archive Late Guest",
      clientPhone: "16045550163",
      start: past,
      noShowFeeCents: 1700,
    });
    cancelledSnapshot = await loadSourceSnapshot(fx.cancelledId);
    noShowSnapshot = await loadSourceSnapshot(fx.noShowId);
  });

  test.afterAll(async () => {
    if (!fx) return;
    // Remove the linked child before its ON DELETE RESTRICT source.
    await supabaseAdmin
      .from("bookings")
      .delete()
      .eq("salon_id", fx.salonId)
      .not("recovered_from_booking_id" as never, "is", null);
    await cleanupTestSalon(fx.slug);
    await cleanupTestSalon(fx.otherSlug);
    await cleanupTestUser(fx.admin.userId);
    await cleanupTestUser(fx.receptionist.userId);
    await cleanupTestUser(fx.otherAdmin.userId);
  });

  test("real Admin can inspect cancelled and no-show history without mutation controls", async ({
    page,
  }) => {
    await loginAs(page, fx.admin);
    await page.goto(`/dashboard/${encodeURIComponent(fx.slug)}/activity`);
    await expect(
      page.getByRole("heading", { name: "Nhật ký hoạt động" }),
    ).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("activity-tab-cancelled").click();
    await page
      .getByTestId("activity-open-archived-booking")
      .filter({ hasText: "Archive Cancelled Guest" })
      .click();
    const cancelledDetail = page.getByTestId("archived-booking-detail");
    await expect(cancelledDetail).toContainText("Archive Cancelled Guest");
    await expect(cancelledDetail).toContainText("Đã huỷ");
    await expect(cancelledDetail).not.toContainText("16045550162");
    await expect(page.getByTestId("archived-booking-recover")).toBeEnabled();
    await page.getByRole("button", { name: "Đóng" }).click();

    await page.getByTestId("activity-tab-no_show").click();
    await page
      .getByTestId("activity-open-archived-booking")
      .filter({ hasText: "Archive Late Guest" })
      .click();
    const noShowDetail = page.getByTestId("archived-booking-detail");
    await expect(noShowDetail).toContainText("Archive Late Guest");
    await expect(noShowDetail).toContainText("Không đến");
    await expect(noShowDetail).toContainText("$17.00");
    await expect(noShowDetail).toContainText("Đã miễn phí");
    await expect(noShowDetail).not.toContainText("16045550163");
    await expect(page.getByTestId("archived-booking-recover")).toBeEnabled();
  });

  test("active server actions and direct writes cannot reopen or rewrite terminal sources", async ({
    page,
  }) => {
    await loginAs(page, fx.admin);
    await openCenter(page, fx.slug);

    for (const bookingId of [fx.cancelledId, fx.noShowId]) {
      const response = await invokeServerAction(page, "updateBookingStatus", [
        bookingId,
        "confirmed",
        fx.slug,
      ]);
      expect(response).toContain("invalid_transition");
    }

    const { error: reopenError } = await supabaseAdmin
      .from("bookings")
      .update({ status: "confirmed" })
      .eq("id", fx.cancelledId);
    expect(reopenError?.code).toBe("23514");

    const { error: identityError } = await supabaseAdmin
      .from("bookings")
      .update({ client_name: "Rewritten Guest" })
      .eq("id", fx.noShowId);
    expect(identityError?.code).toBe("23514");

    const { error: archiveHideError } = await supabaseAdmin
      .from("bookings")
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", fx.noShowId);
    expect(archiveHideError?.code).toBe("23514");

    // Attendance is immutable, but the eventual no-show fee decision remains
    // operationally writable and visible in archived detail.
    const { error: feeOutcomeError } = await supabaseAdmin
      .from("bookings")
      .update({ noshow_charge_status: "saved" } as never)
      .eq("id", fx.noShowId);
    expect(feeOutcomeError).toBeNull();
    const { data: feeOutcome } = await supabaseAdmin
      .from("bookings")
      .select("noshow_charge_status")
      .eq("id", fx.noShowId)
      .single();
    expect(feeOutcome?.noshow_charge_status).toBe("saved");
    const { error: restoreFeeOutcomeError } = await supabaseAdmin
      .from("bookings")
      .update({ noshow_charge_status: "waived" } as never)
      .eq("id", fx.noShowId);
    expect(restoreFeeOutcomeError).toBeNull();

    expect(await loadSourceSnapshot(fx.cancelledId)).toEqual(cancelledSnapshot);
    expect(await loadSourceSnapshot(fx.noShowId)).toEqual(noShowSnapshot);
  });

  test("linked late-arrival child is audited and retries are tenant/role safe", async ({
    browser,
    page,
  }) => {
    await loginAs(page, fx.admin);
    await page.goto(`/dashboard/${encodeURIComponent(fx.slug)}/activity`);
    await page.getByTestId("activity-tab-no_show").click();
    await page
      .getByTestId("activity-open-archived-booking")
      .filter({ hasText: "Archive Late Guest" })
      .click();
    await page.getByTestId("archived-booking-recover").click();
    await page.waitForURL(/\/center(?:\?|$)/, { timeout: 30_000 });
    await page
      .getByTestId("walkin-recovery-notice")
      .waitFor({ state: "visible", timeout: 45_000 });
    await expect(page.getByTestId("walkin-name")).toHaveValue(
      "Archive Late Guest",
    );
    await expect
      .poll(async () => {
        const value = await page.getByTestId("walkin-phone").inputValue();
        return value.replace(/\D/g, "");
      })
      .toContain("6045550163");
    await expect(
      page.locator(`#walkin-service-${fx.serviceId}.border-nq-primary`),
    ).toBeAttached();
    await clickWalkinSubmit(page);

    await expect
      .poll(
        async () => {
          const { data } = await supabaseAdmin
            .from("bookings")
            .select(
              "id, status, source, client_name, client_phone, service_id, recovered_from_booking_id, recovery_kind, recovered_by_user_id, idempotency_key",
            )
            .eq("salon_id", fx.salonId)
            .eq("recovered_from_booking_id" as never, fx.noShowId)
            .maybeSingle();
          return data as Record<string, unknown> | null;
        },
        { timeout: 20_000, intervals: [250, 500, 1_000] },
      )
      .not.toBeNull();
    // Read the canonical row once after the presence barrier.
    const { data: recovered, error: recoveryError } = await supabaseAdmin
      .from("bookings")
      .select(
        "id, status, source, client_name, client_phone, service_id, recovered_from_booking_id, recovery_kind, recovered_by_user_id, idempotency_key",
      )
      .eq("salon_id", fx.salonId)
      .eq("recovered_from_booking_id" as never, fx.noShowId)
      .single();
    if (recoveryError || !recovered) {
      throw new Error(recoveryError?.message ?? "recovery child missing");
    }
    const recoveredRow = recovered as unknown as Record<string, unknown>;
    expect(recoveredRow).toMatchObject({
      status: "waiting",
      source: "walkin",
      client_name: "Archive Late Guest",
      service_id: fx.serviceId,
      recovered_from_booking_id: fx.noShowId,
      recovery_kind: "no_show_walkin",
      recovered_by_user_id: fx.admin.userId,
    });
    expect(String(recoveredRow.idempotency_key)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await loadSourceSnapshot(fx.noShowId)).toEqual(noShowSnapshot);

    await expect
      .poll(
        async () => {
          const { data } = await supabaseAdmin
            .from("booking_events" as never)
            .select("actor_user_id, actor_role, payload" as never)
            .eq("booking_id", String(recoveredRow.id))
            .eq("event_type", "booking_recovered")
            .maybeSingle();
          return data as unknown as Record<string, unknown> | null;
        },
        { timeout: 10_000, intervals: [200, 500, 1_000] },
      )
      .toMatchObject({
        actor_user_id: fx.admin.userId,
        actor_role: "admin",
        payload: {
          sourceBookingId: fx.noShowId,
          recoveryKind: "no_show_walkin",
        },
      });

    const recoveryInput = {
      salonId: fx.salonId,
      clientName: "Archive Late Guest",
      clientPhone: "16045550163",
      serviceId: fx.serviceId,
      recovery: {
        sourceBookingId: fx.noShowId,
        kind: "no_show_walkin",
        requestId: String(recoveredRow.idempotency_key),
      },
    };
    const exactRetry = await invokeServerAction(page, "addWalkinToQueue", [
      fx.slug,
      recoveryInput,
    ]);
    expect(exactRetry).toContain(String(recoveredRow.id));
    expect(await childCount()).toBe(1);

    const duplicateRetry = await invokeServerAction(page, "addWalkinToQueue", [
      fx.slug,
      {
        ...recoveryInput,
        recovery: { ...recoveryInput.recovery, requestId: randomUUID() },
      },
    ]);
    expect(duplicateRetry).toContain("already_recovered");
    expect(await childCount()).toBe(1);

    const receptionistContext = await browser.newContext();
    try {
      const receptionistPage = await receptionistContext.newPage();
      await loginAs(receptionistPage, fx.receptionist);
      await openCenter(receptionistPage, fx.slug);
      const denied = await invokeServerAction(
        receptionistPage,
        "addWalkinToQueue",
        [
          fx.slug,
          {
            ...recoveryInput,
            recovery: { ...recoveryInput.recovery, requestId: randomUUID() },
          },
        ],
      );
      expect(denied).toContain("unauthorized");
    } finally {
      await receptionistContext.close();
    }

    const otherAdminContext = await browser.newContext();
    try {
      const otherAdminPage = await otherAdminContext.newPage();
      await loginAs(otherAdminPage, fx.otherAdmin);
      await openCenter(otherAdminPage, fx.otherSlug);
      const denied = await invokeServerAction(
        otherAdminPage,
        "addWalkinToQueue",
        [
          fx.slug,
          {
            ...recoveryInput,
            recovery: { ...recoveryInput.recovery, requestId: randomUUID() },
          },
        ],
      );
      expect(denied).toContain("unauthorized");
    } finally {
      await otherAdminContext.close();
    }

    expect(await childCount()).toBe(1);
    expect(await loadSourceSnapshot(fx.noShowId)).toEqual(noShowSnapshot);
  });
});

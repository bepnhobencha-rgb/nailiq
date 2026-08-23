import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { seedTestUser } from "../helpers/db";
import {
  gotoReceptionistCenter,
  rcSlug,
  seedDeskBooking,
  seedReceptionistCenterFixture,
  supabaseAdmin,
  type ReceptionistCenterFixture,
} from "./helpers";

const ENABLED = process.env.MQA0126_FAKE_SQUARE_REFUND === "1";
const LOG_FILE = String(
  process.env.MQA0126_FAKE_SQUARE_LOG_FILE || "",
).trim();
const RUN_NONCE = String(process.env.MQA0126_RUN_NONCE || "").trim();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_TOKEN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const MERCHANT_ID = "fake-local-mqa0126-merchant";
const LOCATION_ID = "fake-local-mqa0126-location";
const APPLICATION_ID = "fake-local-mqa0126-application";
const ACCESS_TOKEN = "fake-local-mqa0126-token";
const DEPOSIT_CENTS = 5_000;
const PARTIAL_REFUND_CENTS = 2_000;
const REMAINING_REFUND_CENTS = DEPOSIT_CENTS - PARTIAL_REFUND_CENTS;

type TestUser = Awaited<ReturnType<typeof seedTestUser>>;

type TransportAudit = {
  kind: string;
  runNonce: string;
  pid: number;
  method?: string;
  origin?: string;
  path?: string;
};

type RefundAudit = TransportAudit & {
  kind: "square_refund";
  method: string;
  path: string;
  paymentId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  refundId: string;
};

let fx: ReceptionistCenterFixture | null = null;
let slug = "";
let owner: TestUser | null = null;
let bookingId: string | null = null;
let parentOperationId: string | null = null;
let paymentId: string | null = null;

function psql(sql: string): string {
  if (
    process.env.NAILIQ_DISPOSABLE_DB !== "1" ||
    process.env.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:54321"
  ) {
    throw new Error("MQA0126 cleanup refuses a non-disposable database");
  }
  return execFileSync(
    "psql",
    [
      "--no-psqlrc",
      "--host",
      "127.0.0.1",
      "--port",
      "54322",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
      "--set",
      "ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      "--command",
      sql,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PGPASSWORD: "postgres" },
      maxBuffer: 1024 * 1024,
    },
  ).trim();
}

function uuidSql(value: string | null): string {
  if (!value || !UUID_RE.test(value)) {
    throw new Error("MQA0126 cleanup requires an exact UUID");
  }
  return `'${value}'::uuid`;
}

function uuidTokens(value: string): string[] {
  return Array.from(value.matchAll(UUID_TOKEN_RE), (match) =>
    match[0].toLowerCase(),
  );
}

function cleanupAndVerifyFixture(): void {
  if (!fx?.salonId) return;
  const salon = uuidSql(fx.salonId);
  const user = owner?.userId ? uuidSql(owner.userId) : null;

  psql(`
    BEGIN;
    DELETE FROM public.booking_cancel_deposit_refund_sagas WHERE salon_id=${salon};
    DELETE FROM public.booking_payment_operations WHERE salon_id=${salon};
    DELETE FROM public.salons WHERE id=${salon};
    ${user ? `DELETE FROM auth.users WHERE id=${user};` : ""}
    COMMIT;
  `);

  const counts = JSON.parse(psql(`
    SELECT json_build_object(
      'salons',(SELECT count(*) FROM public.salons WHERE id=${salon}),
      'members',(SELECT count(*) FROM public.salon_members WHERE salon_id=${salon}),
      'bookings',(SELECT count(*) FROM public.bookings WHERE salon_id=${salon}),
      'operations',(SELECT count(*) FROM public.booking_payment_operations WHERE salon_id=${salon}),
      'sagas',(SELECT count(*) FROM public.booking_cancel_deposit_refund_sagas WHERE salon_id=${salon}),
      'refund_inbox',(SELECT count(*) FROM public.square_refund_webhook_inbox WHERE salon_id=${salon}),
      'square_integration',(SELECT count(*) FROM public.square_integrations WHERE salon_id=${salon}),
      'booking_events',(SELECT count(*) FROM public.booking_events WHERE salon_id=${salon}),
      'notification_outbox',(SELECT count(*) FROM public.staff_action_notification_outbox WHERE salon_id=${salon}),
      'notification_deliveries',(SELECT count(*) FROM public.staff_action_notification_deliveries WHERE salon_id=${salon}),
      'notification_envelopes',(SELECT count(*) FROM public.staff_action_notification_envelopes e JOIN public.staff_action_notification_deliveries d ON d.id=e.delivery_id WHERE d.salon_id=${salon}),
      'owner_notification_log',(SELECT count(*) FROM public.owner_notification_log WHERE salon_id=${salon}),
      'transition_email_outbox',(SELECT count(*) FROM public.customer_booking_transition_email_outbox WHERE salon_id=${salon}),
      'auth_user',${user ? `(SELECT count(*) FROM auth.users WHERE id=${user})` : "0"}
    )::text;
  `)) as Record<string, number>;

  expect(counts).toEqual({
    salons: 0,
    members: 0,
    bookings: 0,
    operations: 0,
    sagas: 0,
    refund_inbox: 0,
    square_integration: 0,
    booking_events: 0,
    notification_outbox: 0,
    notification_deliveries: 0,
    notification_envelopes: 0,
    owner_notification_log: 0,
    transition_email_outbox: 0,
    auth_user: 0,
  });
}

function refundAudit(): RefundAudit[] {
  return transportAudit().filter(
    (entry): entry is RefundAudit => entry.kind === "square_refund",
  );
}

function transportAudit(): TransportAudit[] {
  const raw = readFileSync(LOG_FILE, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => JSON.parse(line) as TransportAudit)
    .filter((entry) => entry.runNonce === RUN_NONCE);
}

async function loginOwner(page: Page): Promise<void> {
  if (!owner || !fx) throw new Error("MQA0126 owner fixture is unavailable");
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(owner.email);
  await page.locator('input[type="password"]').fill(owner.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
  await gotoReceptionistCenter(page, fx.slug, {
    dateYmd: fx.ymdUtc,
    useDemoCookie: false,
  });
}

async function financialSnapshot() {
  if (!fx || !bookingId) throw new Error("MQA0126 booking fixture is unavailable");
  const [booking, operations, sagas] = await Promise.all([
    supabaseAdmin
      .from("bookings")
      .select("status, deposit_status, deposit_refunded_cents, deposit_refund_status")
      .eq("id", bookingId)
      .eq("salon_id", fx.salonId)
      .single(),
    supabaseAdmin
      .from("booking_payment_operations" as never)
      .select(
        "id, request_id, parent_operation_id, parent_payment_id, provider_refund_id, provider_idempotency_key, amount_cents, currency, status, provider_status, material_json, result_json",
      )
      .eq("salon_id", fx.salonId)
      .eq("booking_id", bookingId)
      .eq("operation_kind", "deposit_refund"),
    supabaseAdmin
      .from("booking_cancel_deposit_refund_sagas" as never)
      .select(
        "request_id, booking_id, requested_amount_cents, refund_operation_id, status, cancellation_transition_version, result_json",
      )
      .eq("salon_id", fx.salonId)
      .eq("booking_id", bookingId),
  ]);

  if (booking.error) throw booking.error;
  if (operations.error) throw operations.error;
  if (sagas.error) throw sagas.error;
  return {
    booking: booking.data as Record<string, unknown>,
    operations: (operations.data ?? []) as Record<string, unknown>[],
    sagas: (sagas.data ?? []) as Record<string, unknown>[],
  };
}

test.describe("MQA-0126 local refund UI/runtime proof", () => {
  test.skip(
    !ENABLED,
    "Explicit opt-in plus a disposable local database and fake Square preload are required.",
  );

  test.beforeAll(async ({}, testInfo) => {
    if (!LOG_FILE) throw new Error("MQA0126 fake Square log file is required");
    const exactConfig = resolve(
      process.cwd(),
      "e2e/mqa0126.playwright.config.ts",
    );
    if (
      typeof testInfo.config.configFile !== "string" ||
      resolve(testInfo.config.configFile) !== exactConfig ||
      !UUID_RE.test(RUN_NONCE) ||
      testInfo.project.use.baseURL !== "http://127.0.0.1:3100" ||
      process.env.MQA0126_APP_URL !== "http://127.0.0.1:3100" ||
      process.env.NAILIQ_DISPOSABLE_DB !== "1" ||
      process.env.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:54321" ||
      process.env.SUPABASE_INTERNAL_URL !== "http://127.0.0.1:54321"
    ) {
      throw new Error(
        "MQA0126 refuses to seed outside its exact isolated loopback config",
      );
    }
    if (!transportAudit().some((entry) => entry.kind === "transport_ready")) {
      throw new Error(
        "MQA0126 refuses to seed without the fake transport ready marker",
      );
    }
    slug = rcSlug(testInfo.project.name);
    fx = await seedReceptionistCenterFixture(slug);

    owner = await seedTestUser();
    const memberInsert = await supabaseAdmin.from("salon_members").insert({
      salon_id: fx.salonId,
      user_id: owner.userId,
      role: "owner",
    });
    if (memberInsert.error) throw memberInsert.error;

    const salonUpdate = await supabaseAdmin
      .from("salons")
      .update({
        currency_code: "CAD",
        payment_provider: "square",
        sms_outbound_enabled: false,
        email_outbound_enabled: false,
        staff_notification_settings: {
          enabled: false,
          defaultLocale: "en",
          channels: { sms: false, email: false },
          eventDefaults: {
            create: false,
            reschedule: false,
            cancel: false,
            no_show: false,
            staff_change: false,
          },
        },
        owner_notification_settings: {
          enabled: false,
          notifyMembers: false,
          customEmails: [],
          events: {
            new: false,
            reschedule: false,
            cancel: false,
            no_show: false,
          },
        },
        feature_flags: {
          group_booking_enabled: true,
          archived_booking_recovery_enabled: true,
        },
      } as never)
      .eq("id", fx.salonId);
    if (salonUpdate.error) throw salonUpdate.error;

    const integrationInsert = await supabaseAdmin
      .from("square_integrations" as never)
      .insert({
        salon_id: fx.salonId,
        merchant_id: MERCHANT_ID,
        location_id: LOCATION_ID,
        access_token: ACCESS_TOKEN,
        application_id: APPLICATION_ID,
        enabled: true,
        deposit_enabled: true,
        environment: "sandbox",
        reverse_create_enabled: false,
        sync_push_create: false,
        sync_push_update: false,
        sync_push_cancel: false,
        loyalty_sync_enabled: false,
        gift_cards_sync_enabled: false,
        inventory_sync_enabled: false,
      });
    if (integrationInsert.error) throw integrationInsert.error;

    const startIso = new Date(`${fx.ymdUtc}T14:00:00.000Z`).toISOString();
    const endIso = new Date(`${fx.ymdUtc}T14:55:00.000Z`).toISOString();
    bookingId = await seedDeskBooking(fx.salonId, {
      clientName: "Te2eGuestMQA0126",
      serviceId: fx.serviceIds[0]!,
      staffId: fx.freeStaffId,
      startIso,
      endIso,
      status: "confirmed",
      clientPhone: null,
    });
    paymentId = `fake-local-payment-${randomUUID()}`;
    const now = new Date().toISOString();
    const bookingUpdate = await supabaseAdmin
      .from("bookings")
      .update({
        deposit_required: true,
        deposit_amount_cents: DEPOSIT_CENTS,
        deposit_reason: "MQA0126 disposable local fixture",
        deposit_status: "paid",
        deposit_paid_at: now,
        deposit_hold: false,
        verification_method: "deposit",
        verification_completed_at: now,
        square_payment_id: paymentId,
        deposit_refunded_cents: 0,
        deposit_refund_status: "none",
        deposit_payment_ledger_enforced_at: now,
      } as never)
      .eq("id", bookingId)
      .eq("salon_id", fx.salonId);
    if (bookingUpdate.error) throw bookingUpdate.error;

    parentOperationId = randomUUID();
    const providerAccountFingerprint = createHash("sha256")
      .update(`square:${MERCHANT_ID}:${LOCATION_ID}:sandbox`, "utf8")
      .digest("hex");
    const providerMaterial = {
      provider_account_id: MERCHANT_ID,
      provider_location_id: LOCATION_ID,
      provider_application_id: APPLICATION_ID,
      provider_environment: "sandbox",
      currency: "CAD",
      saved_card_id: null,
      customer_id: null,
      parent_payment_id: null,
    };
    const material = {
      salon_id: fx.salonId,
      booking_id: bookingId,
      operation_kind: "deposit_charge",
      provider: "square",
      provider_account_fingerprint: providerAccountFingerprint,
      amount_cents: DEPOSIT_CENTS,
      currency: "CAD",
      parent_payment_id: null,
      parent_operation_id: null,
      operation_occurrence_version: null,
      captured_cents: DEPOSIT_CENTS,
      refunded_cents: 0,
      reserved_cents: 0,
      remaining_refundable_cents: 0,
      provider_material: providerMaterial,
    };
    const materialFingerprint = createHash("sha256")
      .update(JSON.stringify(material), "utf8")
      .digest("hex");
    const parentInsert = await supabaseAdmin
      .from("booking_payment_operations" as never)
      .insert({
        id: parentOperationId,
        salon_id: fx.salonId,
        booking_id: bookingId,
        request_id: randomUUID(),
        operation_kind: "deposit_charge",
        provider: "square",
        provider_account_fingerprint: providerAccountFingerprint,
        amount_cents: DEPOSIT_CENTS,
        currency: "CAD",
        material_fingerprint: materialFingerprint,
        material_json: material,
        provider_material: providerMaterial,
        parent_payment_id: null,
        parent_operation_id: null,
        provider_payment_id: paymentId,
        provider_status: "COMPLETED",
        provider_idempotency_key: `nq:${parentOperationId}`,
        status: "succeeded",
        attempt_count: 1,
        result_json: {
          operation_id: parentOperationId,
          provider_payment_id: paymentId,
          status: "succeeded",
        },
        completed_at: now,
      });
    if (parentInsert.error) throw parentInsert.error;
  });

  test.afterAll(async () => {
    cleanupAndVerifyFixture();
  });

  test("blocks excess, refunds CAD 20 on cancel, then refunds the CAD 30 remainder from Activity with exact response-loss replay", async ({
    page,
  }) => {
    if (!fx || !bookingId || !parentOperationId || !paymentId) {
      throw new Error("MQA0126 fixture was not seeded");
    }
    const exactBookingId = bookingId;
    const exactSalonId = fx.salonId;

    const blockedBrowserEgress: string[] = [];
    let excessActionAttempts = 0;
    let partialActionAttempts = 0;
    let remainingActionAttempts = 0;
    let firstPartialActionStatus: number | null = null;
    let firstRemainingActionStatus: number | null = null;
    const remainingRequestBodies: string[] = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const allowed = new Set([
        "127.0.0.1:54321",
        "127.0.0.1:3100",
      ]);
      if (!allowed.has(url.host)) {
        blockedBrowserEgress.push(`${request.method()} ${url.origin}${url.pathname}`);
        await route.abort("blockedbyclient");
        return;
      }
      const postData = request.postData() ?? "";
      const isRefundAction =
        request.method() === "POST" &&
        typeof request.headers()["next-action"] === "string" &&
        postData.includes(exactBookingId) &&
        (postData.includes(String(DEPOSIT_CENTS + 1)) ||
          postData.includes(String(PARTIAL_REFUND_CENTS)) ||
          postData.includes(String(REMAINING_REFUND_CENTS)));
      if (isRefundAction) {
        if (postData.includes(String(DEPOSIT_CENTS + 1))) {
          excessActionAttempts += 1;
        } else if (
          url.pathname.endsWith("/center") &&
          postData.includes(String(PARTIAL_REFUND_CENTS))
        ) {
          partialActionAttempts += 1;
          if (partialActionAttempts === 1) {
            const committed = await route.fetch();
            firstPartialActionStatus = committed.status();
            await route.abort("failed");
            return;
          }
        } else if (
          url.pathname.endsWith("/activity") &&
          postData.includes(String(REMAINING_REFUND_CENTS))
        ) {
          remainingActionAttempts += 1;
          remainingRequestBodies.push(postData);
          if (remainingActionAttempts === 1) {
            const committed = await route.fetch();
            firstRemainingActionStatus = committed.status();
            await route.abort("failed");
            return;
          }
        }
      }
      await route.continue();
    });

    await loginOwner(page);
    const block = page.getByTestId(`booking-block-${bookingId}`);
    await expect(block).toBeVisible({ timeout: 15_000 });
    await block.click();
    await expect(page.getByTestId("booking-detail-drawer")).toBeVisible();
    await page.getByTestId("drawer-cancel-booking").click();

    const amountInput = page.getByTestId("deposit-refund-amount");
    const refundButton = page.getByTestId("deposit-cancel-refund");
    await expect(amountInput).toHaveValue("50");
    await amountInput.fill("50.01");
    await refundButton.click();
    await expect(page.getByText("Số tiền hoàn không hợp lệ.")).toBeVisible();
    expect(excessActionAttempts).toBe(0);
    expect(partialActionAttempts).toBe(0);
    expect(remainingActionAttempts).toBe(0);
    expect(refundAudit()).toHaveLength(0);
    const beforeValid = await financialSnapshot();
    expect(beforeValid.booking.status).toBe("confirmed");
    expect(beforeValid.operations).toHaveLength(0);
    expect(beforeValid.sagas).toHaveLength(0);

    await amountInput.fill("20.00");
    await refundButton.click();

    await expect.poll(async () => {
      const snapshot = await financialSnapshot();
      return {
        booking: snapshot.booking,
        operationCount: snapshot.operations.length,
        operationStatus: snapshot.operations[0]?.status ?? null,
        sagaCount: snapshot.sagas.length,
        sagaStatus: snapshot.sagas[0]?.status ?? null,
        providerCalls: refundAudit().length,
      };
    }, { timeout: 30_000 }).toEqual({
      booking: {
        status: "cancelled",
        deposit_status: "paid",
        deposit_refunded_cents: PARTIAL_REFUND_CENTS,
        deposit_refund_status: "partial",
      },
      operationCount: 1,
      operationStatus: "succeeded",
      sagaCount: 1,
      sagaStatus: "refunded",
      providerCalls: 1,
    });
    expect(firstPartialActionStatus).toBe(200);
    expect(partialActionAttempts).toBe(1);
    await expect(amountInput).toHaveValue("20.00");
    await expect(refundButton).toBeEnabled();

    await refundButton.click();
    await expect(page.getByTestId("deposit-refund-amount")).toHaveCount(0);
    await expect(block).toHaveCount(0, { timeout: 15_000 });

    expect(partialActionAttempts).toBe(2);

    await expect.poll(async () => {
      const { count, error } = await supabaseAdmin
        .from("booking_events" as never)
        .select("id", { count: "exact", head: true })
        .eq("salon_id", exactSalonId)
        .eq("booking_id", exactBookingId)
        .eq("event_type", "booking_cancelled");
      if (error) throw error;
      return count ?? 0;
    }, { timeout: 15_000 }).toBeGreaterThan(0);

    await page.goto(`/dashboard/${encodeURIComponent(slug)}/activity`);
    await page.getByTestId("activity-tab-cancelled").click();
    const archivedRow = page
      .getByTestId("activity-open-archived-booking")
      .filter({ hasText: "Te2eGuestMQA0126" });
    await expect(archivedRow.first()).toBeVisible();
    await archivedRow.first().click();
    await expect(page.getByTestId("archived-booking-detail")).toBeVisible();
    const depositSummary = page.getByTestId("archived-deposit-summary");
    await expect(depositSummary).toContainText(/(?:CA)?\$50\.00/);
    await expect(depositSummary).toContainText(/(?:CA)?\$20\.00/);
    await expect(depositSummary).toContainText(/(?:CA)?\$30\.00/);

    await page.getByTestId("archived-refund-remaining-open").click();
    await expect(
      page.getByTestId("archived-refund-remaining-confirmation"),
    ).toContainText(/(?:CA)?\$30\.00/);
    const remainingSubmit = page.getByTestId(
      "archived-refund-remaining-submit",
    );
    await remainingSubmit.click();

    await expect.poll(async () => {
      const snapshot = await financialSnapshot();
      return {
        booking: snapshot.booking,
        operationAmounts: snapshot.operations
          .map((operation) => Number(operation.amount_cents))
          .sort((a, b) => a - b),
        sagaCount: snapshot.sagas.length,
        providerAmounts: refundAudit().map((audit) => audit.amountCents),
      };
    }, { timeout: 30_000 }).toEqual({
      booking: {
        status: "cancelled",
        deposit_status: "refunded",
        deposit_refunded_cents: DEPOSIT_CENTS,
        deposit_refund_status: "full",
      },
      operationAmounts: [PARTIAL_REFUND_CENTS, REMAINING_REFUND_CENTS],
      sagaCount: 1,
      providerAmounts: [PARTIAL_REFUND_CENTS, REMAINING_REFUND_CENTS],
    });
    expect(firstRemainingActionStatus).toBe(200);
    expect(remainingActionAttempts).toBe(1);
    await expect(page.getByTestId("archived-refund-status")).toContainText(
      "Mất phản hồi",
    );

    await remainingSubmit.click();
    await expect(page.getByTestId("archived-refund-status")).toContainText(
      /Đã hoàn (?:CA)?\$30\.00/,
    );
    await expect(depositSummary).toContainText(/(?:CA)?\$0\.00/);
    await expect(depositSummary).toContainText("Tiền cọc đã được hoàn hết.");
    await expect(
      page.getByTestId("archived-refund-remaining-open"),
    ).toHaveCount(0);

    const finalSnapshot = await financialSnapshot();
    const operations = [...finalSnapshot.operations].sort(
      (a, b) => Number(a.amount_cents) - Number(b.amount_cents),
    );
    const partialOperation = operations[0]!;
    const remainingOperation = operations[1]!;
    const saga = finalSnapshot.sagas[0]!;
    const audits = refundAudit();
    expect(excessActionAttempts).toBe(0);
    expect(remainingActionAttempts).toBe(2);
    expect(remainingRequestBodies).toHaveLength(2);
    expect(audits.map((audit) => audit.amountCents)).toEqual([
      PARTIAL_REFUND_CENTS,
      REMAINING_REFUND_CENTS,
    ]);
    expect(finalSnapshot.operations).toHaveLength(2);
    expect(finalSnapshot.sagas).toHaveLength(1);
    expect(
      operations.reduce(
        (sum, operation) => sum + Number(operation.amount_cents),
        0,
      ),
    ).toBe(DEPOSIT_CENTS);
    for (const operation of operations) {
      expect(operation).toMatchObject({
        parent_operation_id: parentOperationId,
        parent_payment_id: paymentId,
        currency: "CAD",
        status: "succeeded",
        provider_status: "COMPLETED",
      });
    }
    expect(partialOperation.amount_cents).toBe(PARTIAL_REFUND_CENTS);
    expect(remainingOperation.amount_cents).toBe(REMAINING_REFUND_CENTS);
    expect(partialOperation.request_id).not.toBe(remainingOperation.request_id);
    const remainingRequestId = String(remainingOperation.request_id).toLowerCase();
    for (const body of remainingRequestBodies) {
      expect(uuidTokens(body)).toContain(remainingRequestId);
    }
    expect(saga).toMatchObject({
      request_id: partialOperation.request_id,
      booking_id: bookingId,
      requested_amount_cents: PARTIAL_REFUND_CENTS,
      refund_operation_id: partialOperation.id,
      status: "refunded",
    });
    expect(audits[0]).toMatchObject({
      method: "POST",
      path: "/v2/refunds",
      paymentId,
      amountCents: PARTIAL_REFUND_CENTS,
      currency: "CAD",
      idempotencyKey: `nq:${partialOperation.id}`,
      refundId: partialOperation.provider_refund_id,
    });
    expect(audits[1]).toMatchObject({
      method: "POST",
      path: "/v2/refunds",
      paymentId,
      amountCents: REMAINING_REFUND_CENTS,
      currency: "CAD",
      idempotencyKey: `nq:${remainingOperation.id}`,
      refundId: remainingOperation.provider_refund_id,
    });
    expect(blockedBrowserEgress).toEqual([]);

    const allTransportAudit = transportAudit();
    expect(
      allTransportAudit.filter(
        (entry) =>
          !["transport_ready", "square_refund", "blocked_external"].includes(
            entry.kind,
          ),
      ),
    ).toEqual([]);
    expect(
      allTransportAudit.filter((entry) => entry.kind === "transport_ready")
        .length,
    ).toBeGreaterThan(0);
    expect(
      allTransportAudit
        .filter((entry) => entry.kind === "blocked_external")
        .map(({ method, origin, path }) => ({ method, origin, path })),
    ).toEqual([
      {
        method: "GET",
        origin: "https://registry.npmjs.org",
        path: "/-/package/next/dist-tags",
      },
    ]);
  });
});

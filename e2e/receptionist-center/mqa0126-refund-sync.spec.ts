import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  expect,
  test,
  type Page,
  type Request as PlaywrightRequest,
} from "@playwright/test";

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
let admin: TestUser | null = null;
let adminBookingId: string | null = null;
let adminParentOperationId: string | null = null;
let foreignBookingId: string | null = null;
let attackerFx: ReceptionistCenterFixture | null = null;
let attackerAdmin: TestUser | null = null;
let attackerBookingId: string | null = null;
let capturedAttackerRefundAction: {
  url: string;
  headers: Record<string, string>;
  body: string;
} | null = null;

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

function exactServerActionResultCount(body: string, error: string): number {
  let matches = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.length === 2 &&
      keys[0] === "error" &&
      keys[1] === "ok" &&
      record.ok === false &&
      record.error === error
    ) {
      matches += 1;
      return;
    }
    Object.values(record).forEach(visit);
  };

  for (const line of body.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    try {
      visit(JSON.parse(line.slice(colon + 1)));
    } catch {
      // Flight may include non-JSON control rows. Only decoded JSON rows can
      // constitute the exact Server Action result asserted here.
    }
  }
  return matches;
}

function cleanupAndVerifyFixture(): void {
  const salonIds = Array.from(
    new Set([fx?.salonId, attackerFx?.salonId].filter(Boolean)),
  ) as string[];
  const userIds = Array.from(
    new Set(
      [owner?.userId, admin?.userId, attackerAdmin?.userId].filter(Boolean),
    ),
  ) as string[];
  if (salonIds.length === 0) return;
  const salons = salonIds.map(uuidSql).join(",");
  const users = userIds.map(uuidSql).join(",");

  psql(`
    BEGIN;
    DELETE FROM public.booking_cancel_deposit_refund_sagas WHERE salon_id IN (${salons});
    DELETE FROM public.booking_payment_operations WHERE salon_id IN (${salons});
    DELETE FROM public.salons WHERE id IN (${salons});
    ${users ? `DELETE FROM auth.users WHERE id IN (${users});` : ""}
    COMMIT;
  `);

  const counts = JSON.parse(psql(`
    SELECT json_build_object(
      'salons',(SELECT count(*) FROM public.salons WHERE id IN (${salons})),
      'members',(SELECT count(*) FROM public.salon_members WHERE salon_id IN (${salons})),
      'bookings',(SELECT count(*) FROM public.bookings WHERE salon_id IN (${salons})),
      'operations',(SELECT count(*) FROM public.booking_payment_operations WHERE salon_id IN (${salons})),
      'sagas',(SELECT count(*) FROM public.booking_cancel_deposit_refund_sagas WHERE salon_id IN (${salons})),
      'refund_inbox',(SELECT count(*) FROM public.square_refund_webhook_inbox WHERE salon_id IN (${salons})),
      'square_integration',(SELECT count(*) FROM public.square_integrations WHERE salon_id IN (${salons})),
      'wix_integration',(SELECT count(*) FROM public.wix_integrations WHERE salon_id IN (${salons})),
      'booking_events',(SELECT count(*) FROM public.booking_events WHERE salon_id IN (${salons})),
      'notification_outbox',(SELECT count(*) FROM public.staff_action_notification_outbox WHERE salon_id IN (${salons})),
      'notification_deliveries',(SELECT count(*) FROM public.staff_action_notification_deliveries WHERE salon_id IN (${salons})),
      'notification_envelopes',(SELECT count(*) FROM public.staff_action_notification_envelopes e JOIN public.staff_action_notification_deliveries d ON d.id=e.delivery_id WHERE d.salon_id IN (${salons})),
      'owner_notification_log',(SELECT count(*) FROM public.owner_notification_log WHERE salon_id IN (${salons})),
      'transition_email_outbox',(SELECT count(*) FROM public.customer_booking_transition_email_outbox WHERE salon_id IN (${salons})),
      'auth_user',${users ? `(SELECT count(*) FROM auth.users WHERE id IN (${users}))` : "0"}
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
    wix_integration: 0,
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

function expectExactTransportAudit(expectedRefundAmounts: number[]): void {
  const audit = transportAudit();
  expect(
    audit.filter(
      (entry) =>
        !["transport_ready", "square_refund", "blocked_external"].includes(
          entry.kind,
        ),
    ),
  ).toEqual([]);
  expect(
    audit.filter((entry) => entry.kind === "transport_ready").length,
  ).toBeGreaterThan(0);
  expect(refundAudit().map((entry) => entry.amountCents)).toEqual(
    expectedRefundAmounts,
  );
  expect(
    audit
      .filter((entry) => entry.kind === "blocked_external")
      .map(({ method, origin, path }) => ({ method, origin, path })),
  ).toEqual([
    {
      method: "GET",
      origin: "https://registry.npmjs.org",
      path: "/-/package/next/dist-tags",
    },
  ]);
}

function actionReplayHeaders(
  requestHeaders: Record<string, string>,
  url: URL,
): Record<string, string> {
  const headers = Object.fromEntries(
    [
      "accept",
      "content-type",
      "next-action",
      "next-router-state-tree",
      "origin",
      "referer",
      "user-agent",
    ]
      .filter((name) => typeof requestHeaders[name] === "string")
      .map((name) => [name, requestHeaders[name]!]),
  );
  headers.origin ??= url.origin;
  headers.referer ??= url.href;
  return headers;
}

async function replayBrowserAction(
  page: Page,
  request: PlaywrightRequest,
  body: string,
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}> {
  const url = new URL(request.url());
  if (
    url.origin !== "http://127.0.0.1:3100" ||
    request.method() !== "POST" ||
    typeof request.headers()["next-action"] !== "string"
  ) {
    throw new Error("MQA0126 refuses to replay a non-loopback Server Action");
  }
  const response = await page.request.fetch(url.href, {
    method: "POST",
    headers: actionReplayHeaders(await request.allHeaders(), url),
    data: body,
    failOnStatusCode: false,
  });
  const responseBody = await response.body();
  const responseHeaders = Object.fromEntries(
    Object.entries(response.headers()).filter(
      ([name]) =>
        !["content-length", "content-encoding", "transfer-encoding"].includes(
          name.toLowerCase(),
        ),
    ),
  );
  return {
    status: response.status(),
    headers: responseHeaders,
    body: responseBody,
  };
}

async function loginMember(
  page: Page,
  user: TestUser | null,
  targetFx: ReceptionistCenterFixture | null,
): Promise<void> {
  if (!user || !targetFx) {
    throw new Error("MQA0126 member fixture is unavailable");
  }
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(user.email);
  await page.locator('input[type="password"]').fill(user.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  const expectedDashboardPath = `/dashboard/${encodeURIComponent(targetFx.slug)}`;
  await page.waitForURL(
    (url) =>
      url.origin === "http://127.0.0.1:3100" &&
      url.pathname === expectedDashboardPath,
    { timeout: 60_000, waitUntil: "commit" },
  );
  expect(new URL(page.url()).pathname).toBe(expectedDashboardPath);
  await gotoReceptionistCenter(page, targetFx.slug, {
    dateYmd: targetFx.ymdUtc,
    useDemoCookie: false,
  });
}

async function loginOwner(page: Page): Promise<void> {
  await loginMember(page, owner, fx);
}

async function financialSnapshotFor(
  targetFx: ReceptionistCenterFixture | null,
  targetBookingId: string | null,
) {
  if (!targetFx || !targetBookingId) {
    throw new Error("MQA0126 booking fixture is unavailable");
  }
  const [booking, operations, sagas] = await Promise.all([
    supabaseAdmin
      .from("bookings")
      .select("status, deposit_status, deposit_refunded_cents, deposit_refund_status")
      .eq("id", targetBookingId)
      .eq("salon_id", targetFx.salonId)
      .single(),
    supabaseAdmin
      .from("booking_payment_operations" as never)
      .select(
        "id, request_id, parent_operation_id, parent_payment_id, provider_refund_id, provider_idempotency_key, amount_cents, currency, status, provider_status, material_json, result_json",
      )
      .eq("salon_id", targetFx.salonId)
      .eq("booking_id", targetBookingId)
      .eq("operation_kind", "deposit_refund"),
    supabaseAdmin
      .from("booking_cancel_deposit_refund_sagas" as never)
      .select(
        "request_id, booking_id, requested_amount_cents, refund_operation_id, status, cancellation_transition_version, result_json",
      )
      .eq("salon_id", targetFx.salonId)
      .eq("booking_id", targetBookingId),
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

async function financialSnapshot() {
  return financialSnapshotFor(fx, bookingId);
}

function tenantMutationSnapshot(
  targetFx: ReceptionistCenterFixture,
): Record<string, string> {
  const salon = uuidSql(targetFx.salonId);
  const digest = (table: string, predicate: string): string =>
    `(SELECT md5(COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY to_jsonb(row_data)::text), '[]'::jsonb)::text) FROM ${table} row_data WHERE ${predicate})`;
  return JSON.parse(psql(`
    SELECT json_build_object(
      'salon',${digest("public.salons", `row_data.id=${salon}`)},
      'members',${digest("public.salon_members", `row_data.salon_id=${salon}`)},
      'staff',${digest("public.staff", `row_data.salon_id=${salon}`)},
      'bookings',${digest("public.bookings", `row_data.salon_id=${salon}`)},
      'operations',${digest("public.booking_payment_operations", `row_data.salon_id=${salon}`)},
      'sagas',${digest("public.booking_cancel_deposit_refund_sagas", `row_data.salon_id=${salon}`)},
      'refund_inbox',${digest("public.square_refund_webhook_inbox", `row_data.salon_id=${salon}`)},
      'booking_events',${digest("public.booking_events", `row_data.salon_id=${salon}`)},
      'notification_outbox',${digest("public.staff_action_notification_outbox", `row_data.salon_id=${salon}`)},
      'notification_deliveries',${digest("public.staff_action_notification_deliveries", `row_data.salon_id=${salon}`)},
      'owner_notification_log',${digest("public.owner_notification_log", `row_data.salon_id=${salon}`)},
      'transition_email_outbox',${digest("public.customer_booking_transition_email_outbox", `row_data.salon_id=${salon}`)},
      'square_integration',${digest("public.square_integrations", `row_data.salon_id=${salon}`)},
      'wix_integration',${digest("public.wix_integrations", `row_data.salon_id=${salon}`)},
      'notification_envelopes',(
        SELECT md5(COALESCE(jsonb_agg(to_jsonb(e) ORDER BY to_jsonb(e)::text), '[]'::jsonb)::text)
        FROM public.staff_action_notification_envelopes e
        JOIN public.staff_action_notification_deliveries d ON d.id=e.delivery_id
        WHERE d.salon_id=${salon}
      )
    )::text;
  `)) as Record<string, string>;
}

async function configureRefundSalon(
  targetFx: ReceptionistCenterFixture,
): Promise<void> {
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
    .eq("id", targetFx.salonId);
  if (salonUpdate.error) throw salonUpdate.error;

  const integrationInsert = await supabaseAdmin
    .from("square_integrations" as never)
    .insert({
      salon_id: targetFx.salonId,
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
}

async function seedPartiallyRefundedCancelledBooking(args: {
  targetFx: ReceptionistCenterFixture;
  actorUserId: string;
  clientName: string;
  startHourUtc: number;
}): Promise<{
  bookingId: string;
  parentOperationId: string;
  paymentId: string;
}> {
  const startIso = new Date(
    `${args.targetFx.ymdUtc}T${String(args.startHourUtc).padStart(2, "0")}:00:00.000Z`,
  ).toISOString();
  const endIso = new Date(
    `${args.targetFx.ymdUtc}T${String(args.startHourUtc).padStart(2, "0")}:55:00.000Z`,
  ).toISOString();
  const targetBookingId = await seedDeskBooking(args.targetFx.salonId, {
    clientName: args.clientName,
    serviceId: args.targetFx.serviceIds[0]!,
    staffId: args.targetFx.freeStaffId,
    startIso,
    endIso,
    status: "confirmed",
    clientPhone: null,
  });
  const targetPaymentId = `fake-local-payment-${randomUUID()}`;
  const targetParentOperationId = randomUUID();
  const partialOperationId = randomUUID();
  const now = new Date().toISOString();

  const bookingUpdate = await supabaseAdmin
    .from("bookings")
    .update({
      status: "cancelled",
      deposit_required: true,
      deposit_amount_cents: DEPOSIT_CENTS,
      deposit_reason: "MQA0126 disposable local identity fixture",
      deposit_status: "paid",
      deposit_paid_at: now,
      deposit_hold: false,
      verification_method: "deposit",
      verification_completed_at: now,
      square_payment_id: targetPaymentId,
      deposit_refunded_cents: PARTIAL_REFUND_CENTS,
      deposit_refund_status: "partial",
      deposit_payment_ledger_enforced_at: now,
    } as never)
    .eq("id", targetBookingId)
    .eq("salon_id", args.targetFx.salonId);
  if (bookingUpdate.error) throw bookingUpdate.error;

  const providerAccountFingerprint = createHash("sha256")
    .update(`square:${MERCHANT_ID}:${LOCATION_ID}:sandbox`, "utf8")
    .digest("hex");
  const parentProviderMaterial = {
    provider_account_id: MERCHANT_ID,
    provider_location_id: LOCATION_ID,
    provider_application_id: APPLICATION_ID,
    provider_environment: "sandbox",
    currency: "CAD",
    saved_card_id: null,
    customer_id: null,
    parent_payment_id: null,
  };
  const parentMaterial = {
    salon_id: args.targetFx.salonId,
    booking_id: targetBookingId,
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
    provider_material: parentProviderMaterial,
  };
  const parentFingerprint = createHash("sha256")
    .update(JSON.stringify(parentMaterial), "utf8")
    .digest("hex");
  const parentInsert = await supabaseAdmin
    .from("booking_payment_operations" as never)
    .insert({
      id: targetParentOperationId,
      salon_id: args.targetFx.salonId,
      booking_id: targetBookingId,
      request_id: randomUUID(),
      operation_kind: "deposit_charge",
      provider: "square",
      provider_account_fingerprint: providerAccountFingerprint,
      amount_cents: DEPOSIT_CENTS,
      currency: "CAD",
      material_fingerprint: parentFingerprint,
      material_json: parentMaterial,
      provider_material: parentProviderMaterial,
      parent_payment_id: null,
      parent_operation_id: null,
      provider_payment_id: targetPaymentId,
      provider_status: "COMPLETED",
      provider_idempotency_key: `nq:${targetParentOperationId}`,
      status: "succeeded",
      attempt_count: 1,
      result_json: {
        operation_id: targetParentOperationId,
        provider_payment_id: targetPaymentId,
        status: "succeeded",
      },
      completed_at: now,
    });
  if (parentInsert.error) throw parentInsert.error;

  const refundProviderMaterial = {
    ...parentProviderMaterial,
    parent_payment_id: targetPaymentId,
  };
  const partialMaterial = {
    salon_id: args.targetFx.salonId,
    booking_id: targetBookingId,
    operation_kind: "deposit_refund",
    provider: "square",
    provider_account_fingerprint: providerAccountFingerprint,
    amount_cents: PARTIAL_REFUND_CENTS,
    currency: "CAD",
    parent_payment_id: targetPaymentId,
    parent_operation_id: targetParentOperationId,
    operation_occurrence_version: null,
    captured_cents: DEPOSIT_CENTS,
    refunded_cents: 0,
    reserved_cents: 0,
    remaining_refundable_cents: DEPOSIT_CENTS,
    provider_material: refundProviderMaterial,
  };
  const partialFingerprint = createHash("sha256")
    .update(JSON.stringify(partialMaterial), "utf8")
    .digest("hex");
  const partialInsert = await supabaseAdmin
    .from("booking_payment_operations" as never)
    .insert({
      id: partialOperationId,
      salon_id: args.targetFx.salonId,
      booking_id: targetBookingId,
      request_id: randomUUID(),
      operation_kind: "deposit_refund",
      provider: "square",
      provider_account_fingerprint: providerAccountFingerprint,
      amount_cents: PARTIAL_REFUND_CENTS,
      currency: "CAD",
      material_fingerprint: partialFingerprint,
      material_json: partialMaterial,
      provider_material: refundProviderMaterial,
      parent_payment_id: targetPaymentId,
      parent_operation_id: targetParentOperationId,
      provider_refund_id: `fake_seed_refund_${partialOperationId.replaceAll("-", "")}`,
      provider_status: "COMPLETED",
      provider_idempotency_key: `nq:${partialOperationId}`,
      status: "succeeded",
      attempt_count: 1,
      result_json: {
        operation_id: partialOperationId,
        provider_refund_id: `fake_seed_refund_${partialOperationId.replaceAll("-", "")}`,
        status: "succeeded",
      },
      completed_at: now,
    });
  if (partialInsert.error) throw partialInsert.error;

  const eventInsert = await supabaseAdmin
    .from("booking_events" as never)
    .insert({
      booking_id: targetBookingId,
      salon_id: args.targetFx.salonId,
      actor_user_id: args.actorUserId,
      actor_role: "manager",
      event_type: "booking_cancelled",
      payload: {
        from: "confirmed",
        to: "cancelled",
        client_name: args.clientName,
        source: "mqa0126_identity_fixture",
      },
    });
  if (eventInsert.error) throw eventInsert.error;

  return {
    bookingId: targetBookingId,
    parentOperationId: targetParentOperationId,
    paymentId: targetPaymentId,
  };
}

async function seedIdentityFixtures(): Promise<void> {
  if (
    admin &&
    adminBookingId &&
    adminParentOperationId &&
    foreignBookingId &&
    attackerFx &&
    attackerAdmin &&
    attackerBookingId
  ) {
    return;
  }
  if (!fx || !owner || !slug) {
    throw new Error("MQA0126 owner fixture must finish before identity seeding");
  }

  admin = await seedTestUser();
  const adminMemberInsert = await supabaseAdmin.from("salon_members").insert({
    salon_id: fx.salonId,
    user_id: admin.userId,
    role: "admin",
  });
  if (adminMemberInsert.error) throw adminMemberInsert.error;
  const seededAdminBooking = await seedPartiallyRefundedCancelledBooking({
    targetFx: fx,
    actorUserId: admin.userId,
    clientName: "Te2eGuestMQA0126Admin",
    startHourUtc: 16,
  });
  adminBookingId = seededAdminBooking.bookingId;
  adminParentOperationId = seededAdminBooking.parentOperationId;
  const seededForeignBooking = await seedPartiallyRefundedCancelledBooking({
    targetFx: fx,
    actorUserId: owner.userId,
    clientName: "Te2eGuestMQA0126Foreign",
    startHourUtc: 17,
  });
  foreignBookingId = seededForeignBooking.bookingId;

  attackerFx = await seedReceptionistCenterFixture(`${slug}-tenant-b`);
  await configureRefundSalon(attackerFx);
  attackerAdmin = await seedTestUser();
  const attackerMemberInsert = await supabaseAdmin
    .from("salon_members")
    .insert({
      salon_id: attackerFx.salonId,
      user_id: attackerAdmin.userId,
      role: "admin",
    });
  if (attackerMemberInsert.error) throw attackerMemberInsert.error;
  const seededAttackerBooking = await seedPartiallyRefundedCancelledBooking({
    targetFx: attackerFx,
    actorUserId: attackerAdmin.userId,
    clientName: "Te2eGuestMQA0126TenantB",
    startHourUtc: 15,
  });
  attackerBookingId = seededAttackerBooking.bookingId;
}

test.describe("MQA-0126 local refund UI/runtime proof", () => {
  test.describe.configure({ mode: "serial" });
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
    const ownerActionAudit: Array<{
      path: string;
      hasBooking: boolean;
      hasExcess: boolean;
      hasPartial: boolean;
      hasRemaining: boolean;
    }> = [];
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
      const hasNextAction =
        typeof request.headers()["next-action"] === "string";
      if (request.method() === "POST" && hasNextAction) {
        ownerActionAudit.push({
          path: url.pathname,
          hasBooking: postData.includes(exactBookingId),
          hasExcess: postData.includes(String(DEPOSIT_CENTS + 1)),
          hasPartial: postData.includes(String(PARTIAL_REFUND_CENTS)),
          hasRemaining: postData.includes(String(REMAINING_REFUND_CENTS)),
        });
      }
      const isRefundAction =
        request.method() === "POST" &&
        hasNextAction &&
        postData.includes(exactBookingId) &&
        (postData.includes(String(DEPOSIT_CENTS + 1)) ||
          postData.includes(String(PARTIAL_REFUND_CENTS)) ||
          postData.includes(String(REMAINING_REFUND_CENTS)));
      if (isRefundAction) {
        // React can retain a stale invalid input in the serialized action
        // state. Classify by the current route + valid intended amount first;
        // the CAD 50.01 attempt is already required to stay client-only.
        if (
          url.pathname.endsWith("/center") &&
          postData.includes(String(PARTIAL_REFUND_CENTS))
        ) {
          partialActionAttempts += 1;
          if (partialActionAttempts === 1) {
            const committed = await replayBrowserAction(
              page,
              request,
              postData,
            );
            firstPartialActionStatus = committed.status;
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
            const committed = await replayBrowserAction(
              page,
              request,
              postData,
            );
            firstRemainingActionStatus = committed.status;
            await route.abort("failed");
            return;
          }
        } else if (postData.includes(String(DEPOSIT_CENTS + 1))) {
          excessActionAttempts += 1;
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
    await expect.poll(() => firstPartialActionStatus, {
      message: `sanitized owner action audit: ${JSON.stringify(ownerActionAudit)}`,
    }).toBe(200);
    expect(partialActionAttempts).toBe(1);
    await expect(amountInput).toHaveValue("20.00");
    await expect(refundButton).toBeEnabled();

    await refundButton.click();
    await expect.poll(() => partialActionAttempts, { timeout: 15_000 }).toBe(2);
    await expect(page.getByTestId("deposit-refund-amount")).toHaveCount(0, {
      timeout: 15_000,
    });
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
    const archivedRow = page.getByRole("button", {
      name: /^Chủ tiệm đã hủy lịch hẹn của Te2eGuestMQA0126 Xem chi tiết/,
    });
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
    await expect.poll(() => firstRemainingActionStatus, {
      message: `sanitized owner action audit: ${JSON.stringify(ownerActionAudit)}`,
    }).toBe(200);
    expect(remainingActionAttempts).toBe(1);
    await expect(page.getByTestId("archived-refund-status")).toContainText(
      "Mất phản hồi",
    );

    await remainingSubmit.click();
    await expect.poll(() => remainingActionAttempts, { timeout: 15_000 }).toBe(
      2,
    );
    await expect(page.getByTestId("archived-refund-status")).toContainText(
      /Đã hoàn (?:CA)?\$30\.00/,
      { timeout: 15_000 },
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

    expectExactTransportAudit([
      PARTIAL_REFUND_CENTS,
      REMAINING_REFUND_CENTS,
    ]);
  });

  test("allows an authenticated Admin to refund the exact CAD 30 remainder and replay one UUID after response loss", async ({
    page,
  }) => {
    await seedIdentityFixtures();
    if (!fx || !admin || !adminBookingId || !adminParentOperationId) {
      throw new Error("MQA0126 admin fixture was not seeded");
    }
    const exactBookingId = adminBookingId;
    const providerAuditStart = refundAudit().length;
    let actionAttempts = 0;
    let firstActionStatus: number | null = null;
    const requestBodies: string[] = [];
    const blockedBrowserEgress: string[] = [];

    await page.route("**/*", async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      if (
        !new Set(["127.0.0.1:54321", "127.0.0.1:3100"]).has(
          requestUrl.host,
        )
      ) {
        blockedBrowserEgress.push(
          `${request.method()} ${requestUrl.origin}${requestUrl.pathname}`,
        );
        await route.abort("blockedbyclient");
        return;
      }
      const postData = request.postData() ?? "";
      const isRemainingRefundAction =
        request.method() === "POST" &&
        typeof request.headers()["next-action"] === "string" &&
        requestUrl.pathname.endsWith("/activity") &&
        postData.includes(exactBookingId) &&
        postData.includes(String(REMAINING_REFUND_CENTS));
      if (!isRemainingRefundAction) {
        await route.continue();
        return;
      }
      actionAttempts += 1;
      requestBodies.push(postData);
      if (actionAttempts === 1) {
        const committed = await replayBrowserAction(page, request, postData);
        firstActionStatus = committed.status;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await loginMember(page, admin, fx);
    await page.goto(`/dashboard/${encodeURIComponent(fx.slug)}/activity`);
    await page.getByTestId("activity-tab-cancelled").click();
    const archivedRow = page.getByRole("button", {
      name: /^Quản lý đã hủy lịch hẹn của Te2eGuestMQA0126Admin Xem chi tiết/,
    });
    await expect(archivedRow).toHaveCount(1);
    await archivedRow.click();
    await expect(page.getByTestId("archived-booking-detail")).toBeVisible();
    await expect(page.getByTestId("archived-deposit-summary")).toContainText(
      /(?:CA)?\$30\.00/,
    );
    await page.getByTestId("archived-refund-remaining-open").click();
    const submit = page.getByTestId("archived-refund-remaining-submit");
    await submit.click();

    await expect.poll(async () => {
      const snapshot = await financialSnapshotFor(fx, exactBookingId);
      return {
        booking: snapshot.booking,
        operationAmounts: snapshot.operations
          .map((operation) => Number(operation.amount_cents))
          .sort((a, b) => a - b),
        providerCalls: refundAudit().length - providerAuditStart,
      };
    }, { timeout: 30_000 }).toEqual({
      booking: {
        status: "cancelled",
        deposit_status: "refunded",
        deposit_refunded_cents: DEPOSIT_CENTS,
        deposit_refund_status: "full",
      },
      operationAmounts: [PARTIAL_REFUND_CENTS, REMAINING_REFUND_CENTS],
      providerCalls: 1,
    });
    await expect.poll(() => firstActionStatus).toBe(200);
    expect(actionAttempts).toBe(1);
    await expect(page.getByTestId("archived-refund-status")).toContainText(
      "Mất phản hồi",
    );

    await submit.click();
    await expect.poll(() => actionAttempts, { timeout: 15_000 }).toBe(2);
    await expect(page.getByTestId("archived-refund-status")).toContainText(
      /Đã hoàn (?:CA)?\$30\.00/,
      { timeout: 15_000 },
    );
    expect(actionAttempts).toBe(2);
    expect(requestBodies).toHaveLength(2);

    const finalSnapshot = await financialSnapshotFor(fx, exactBookingId);
    const operations = [...finalSnapshot.operations].sort(
      (a, b) => Number(a.amount_cents) - Number(b.amount_cents),
    );
    const remainingOperation = operations[1]!;
    const remainingRequestId = String(
      remainingOperation.request_id,
    ).toLowerCase();
    for (const body of requestBodies) {
      expect(uuidTokens(body)).toContain(remainingRequestId);
    }
    expect(operations).toHaveLength(2);
    expect(finalSnapshot.sagas).toHaveLength(0);
    expect(remainingOperation).toMatchObject({
      amount_cents: REMAINING_REFUND_CENTS,
      parent_operation_id: adminParentOperationId,
      currency: "CAD",
      status: "succeeded",
      provider_status: "COMPLETED",
    });
    const providerDelta = refundAudit().slice(providerAuditStart);
    expect(providerDelta).toHaveLength(1);
    expect(providerDelta[0]).toMatchObject({
      method: "POST",
      path: "/v2/refunds",
      amountCents: REMAINING_REFUND_CENTS,
      idempotencyKey: `nq:${remainingOperation.id}`,
      refundId: remainingOperation.provider_refund_id,
    });
    expect(blockedBrowserEgress).toEqual([]);
  });

  test("denies a cross-tenant booking substitution before any financial or provider work", async ({
    page,
  }) => {
    if (
      !fx ||
      !foreignBookingId ||
      !attackerFx ||
      !attackerAdmin ||
      !attackerBookingId
    ) {
      throw new Error("MQA0126 cross-tenant fixture was not seeded");
    }
    const exactOwnBookingId = attackerBookingId;
    const exactForeignBookingId = foreignBookingId;
    const providerAuditStart = refundAudit().length;
    const ownBefore = await financialSnapshotFor(
      attackerFx,
      exactOwnBookingId,
    );
    const foreignBefore = await financialSnapshotFor(fx, exactForeignBookingId);
    expect(ownBefore.booking).toMatchObject({
      status: "cancelled",
      deposit_status: "paid",
      deposit_refunded_cents: PARTIAL_REFUND_CENTS,
      deposit_refund_status: "partial",
    });
    expect(foreignBefore.booking).toMatchObject({
      status: "cancelled",
      deposit_status: "paid",
      deposit_refunded_cents: PARTIAL_REFUND_CENTS,
      deposit_refund_status: "partial",
    });
    const ownTenantBefore = tenantMutationSnapshot(attackerFx);
    const foreignTenantBefore = tenantMutationSnapshot(fx);
    let actionAttempts = 0;
    let actionStatus: number | null = null;
    let actionResponseBody = "";
    let actionFulfilled = false;
    const blockedBrowserEgress: string[] = [];

    await page.route("**/*", async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      if (
        !new Set(["127.0.0.1:54321", "127.0.0.1:3100"]).has(
          requestUrl.host,
        )
      ) {
        blockedBrowserEgress.push(
          `${request.method()} ${requestUrl.origin}${requestUrl.pathname}`,
        );
        await route.abort("blockedbyclient");
        return;
      }
      const postData = request.postData() ?? "";
      const isRemainingRefundAction =
        request.method() === "POST" &&
        typeof request.headers()["next-action"] === "string" &&
        requestUrl.pathname.endsWith("/activity") &&
        postData.includes(exactOwnBookingId) &&
        postData.includes(String(REMAINING_REFUND_CENTS));
      if (!isRemainingRefundAction) {
        await route.continue();
        return;
      }
      actionAttempts += 1;
      const requestHeaders = request.headers();
      capturedAttackerRefundAction = {
        url: request.url(),
        headers: actionReplayHeaders(requestHeaders, requestUrl),
        body: postData,
      };
      const tamperedBody = postData.replaceAll(
        exactOwnBookingId,
        exactForeignBookingId,
      );
      if (
        tamperedBody === postData ||
        tamperedBody.includes(exactOwnBookingId) ||
        !tamperedBody.includes(exactForeignBookingId)
      ) {
        throw new Error("MQA0126 cross-tenant request substitution failed");
      }
      const denied = await replayBrowserAction(page, request, tamperedBody);
      actionStatus = denied.status;
      actionResponseBody = denied.body.toString("utf8");
      await route.fulfill({
        status: denied.status,
        headers: denied.headers,
        body: denied.body,
      });
      actionFulfilled = true;
    });

    await loginMember(page, attackerAdmin, attackerFx);
    await page.goto(
      `/dashboard/${encodeURIComponent(attackerFx.slug)}/activity`,
    );
    await page.getByTestId("activity-tab-cancelled").click();
    const archivedRow = page.getByRole("button", {
      name: /^Quản lý đã hủy lịch hẹn của Te2eGuestMQA0126TenantB Xem chi tiết/,
    });
    await expect(archivedRow).toHaveCount(1);
    await archivedRow.click();
    await expect(page.getByTestId("archived-booking-detail")).toBeVisible();
    await page.getByTestId("archived-refund-remaining-open").click();
    await page.getByTestId("archived-refund-remaining-submit").click();

    await expect.poll(() => ({ actionAttempts, actionStatus, actionFulfilled }), {
      timeout: 15_000,
    }).toEqual({
      actionAttempts: 1,
      actionStatus: 200,
      actionFulfilled: true,
    });
    expect(exactServerActionResultCount(actionResponseBody, "not_found")).toBe(
      1,
    );
    expect(capturedAttackerRefundAction).not.toBeNull();
    expect(blockedBrowserEgress).toEqual([]);
    expect(refundAudit()).toHaveLength(providerAuditStart);
    await expect(
      financialSnapshotFor(attackerFx, exactOwnBookingId),
    ).resolves.toEqual(ownBefore);
    await expect(
      financialSnapshotFor(fx, exactForeignBookingId),
    ).resolves.toEqual(foreignBefore);
    expect(tenantMutationSnapshot(attackerFx)).toEqual(ownTenantBefore);
    expect(tenantMutationSnapshot(fx)).toEqual(foreignTenantBefore);
  });

  test("suppresses the refund surface and denies a direct replay when the salon enables Wix", async ({
    page,
  }) => {
    if (!attackerFx || !attackerAdmin || !attackerBookingId) {
      throw new Error("MQA0126 Wix fixture was not seeded");
    }
    if (!capturedAttackerRefundAction) {
      throw new Error("MQA0126 direct-action replay material is unavailable");
    }
    const wixInsert = await supabaseAdmin
      .from("wix_integrations" as never)
      .insert({
        salon_id: attackerFx.salonId,
        site_id: `fake-local-mqa0126-${RUN_NONCE}`,
        enabled: true,
        wix_api_key: "fake-local-mqa0126-wix-key",
      });
    if (wixInsert.error) throw wixInsert.error;

    const providerAuditStart = refundAudit().length;
    const financialBefore = await financialSnapshotFor(
      attackerFx,
      attackerBookingId,
    );
    const tenantBefore = tenantMutationSnapshot(attackerFx);
    const blockedBrowserEgress: string[] = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      if (
        !new Set(["127.0.0.1:54321", "127.0.0.1:3100"]).has(
          requestUrl.host,
        )
      ) {
        blockedBrowserEgress.push(
          `${request.method()} ${requestUrl.origin}${requestUrl.pathname}`,
        );
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await loginMember(page, attackerAdmin, attackerFx);
    await page.goto(
      `/dashboard/${encodeURIComponent(attackerFx.slug)}/activity`,
    );
    await page.getByTestId("activity-tab-cancelled").click();
    const eventRow = page
      .getByTestId("activity-row-event")
      .filter({ hasText: "Te2eGuestMQA0126TenantB" });
    await expect(eventRow).toBeVisible();
    await expect(
      page
        .getByTestId("activity-open-archived-booking")
        .filter({ hasText: "Te2eGuestMQA0126TenantB" }),
    ).toHaveCount(0);
    await expect(page.getByTestId("archived-booking-detail")).toHaveCount(0);
    await expect(
      page.getByTestId("archived-refund-remaining-open"),
    ).toHaveCount(0);

    const replay = capturedAttackerRefundAction;
    const replayUrl = new URL(replay.url);
    expect(replayUrl.origin).toBe("http://127.0.0.1:3100");
    expect(replayUrl.pathname).toBe(
      `/dashboard/${encodeURIComponent(attackerFx.slug)}/activity`,
    );
    const denied = await page.evaluate(async (input) => {
      const response = await window.fetch(input.url, {
        method: "POST",
        headers: input.headers,
        body: input.body,
      });
      return { status: response.status, body: await response.text() };
    }, replay);
    expect(denied.status).toBe(200);
    expect(
      exactServerActionResultCount(denied.body, "feature_disabled"),
    ).toBe(1);
    expect(blockedBrowserEgress).toEqual([]);
    expect(refundAudit()).toHaveLength(providerAuditStart);
    await expect(
      financialSnapshotFor(attackerFx, attackerBookingId),
    ).resolves.toEqual(financialBefore);
    expect(tenantMutationSnapshot(attackerFx)).toEqual(tenantBefore);
    expectExactTransportAudit([
      PARTIAL_REFUND_CENTS,
      REMAINING_REFUND_CENTS,
      REMAINING_REFUND_CENTS,
    ]);
  });
});

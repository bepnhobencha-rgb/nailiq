import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  looseServiceClient: vi.fn(),
  getSquareConfig: vi.fn(),
  listBookings: vi.fn(),
  listCatalogItems: vi.fn(),
  getCustomer: vi.fn(),
  cancelSquareBooking: vi.fn(),
  createSquareBooking: vi.fn(),
  updateSquareBookingTime: vi.fn(),
  ensureSquareCustomer: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/shared/dashboard/sendOwnerBookingNotification", () => ({ sendOwnerBookingNotification: vi.fn() }));
vi.mock("../looseDb", () => ({ looseServiceClient: mocks.looseServiceClient }));
vi.mock("../client", () => ({
  getSquareConfig: mocks.getSquareConfig,
  listBookings: mocks.listBookings,
  listCatalogItems: mocks.listCatalogItems,
  getCustomer: mocks.getCustomer,
  cancelSquareBooking: mocks.cancelSquareBooking,
  createSquareBooking: mocks.createSquareBooking,
  updateSquareBookingTime: mocks.updateSquareBookingTime,
  ensureSquareCustomer: mocks.ensureSquareCustomer,
}));

import { runSquareForwardSync } from "../sync";
import type { LooseDb } from "../looseDb";
import type { SquareConfig } from "../client";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const BOOKING_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "33333333-3333-4333-8333-333333333333";
const STAFF_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const ATTEMPT_TOKEN = "66666666-6666-4666-8666-666666666666";
const SQUARE_BOOKING_ID = "square-booking-1";
const SQUARE_CUSTOMER_ID = "square-customer-1";
const API_VERSION = "2024-12-18";
const NOW = new Date("2026-08-22T12:00:00.000Z");

const BOOKING = {
  id: BOOKING_ID,
  salon_id: SALON_ID,
  service_id: SERVICE_ID,
  staff_id: STAFF_ID,
  client_name: "QA Guest",
  client_phone: "+16045550101",
  client_email: "qa@nailiq.invalid",
  status: "confirmed",
  deleted_at: null,
  start_time_utc: "2026-08-24T17:00:00.000Z",
  end_time_utc: "2026-08-24T17:30:00.000Z",
};

const config: SquareConfig = {
  salonId: SALON_ID,
  merchantId: "merchant-1",
  locationId: "location-1",
  accessToken: "sandbox-token",
  applicationId: "sandbox-app-1",
  environment: "sandbox",
  currency: "CAD",
  sync: {
    pullCreate: true,
    pullUpdate: true,
    pullCancel: true,
    pushCreate: true,
    pushUpdate: false,
    pushCancel: false,
  },
};

const providerBooking = {
  id: SQUARE_BOOKING_ID,
  version: 9,
  status: "ACCEPTED",
  customer_id: SQUARE_CUSTOMER_ID,
  location_id: config.locationId,
  seller_note: `NailIQ booking:${BOOKING_ID}`,
  start_at: BOOKING.start_time_utc,
  appointment_segments: [{
    duration_minutes: 30,
    team_member_id: "team-member-1",
    service_variation_id: "variation-1",
    service_variation_version: 7,
  }],
};

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const accountFingerprint = sha256([
  API_VERSION,
  config.environment,
  config.applicationId,
  config.merchantId,
  config.locationId,
].join("\n"));
const contactFingerprint = sha256("qa guest\n16045550101\nqa@nailiq.invalid");
const materialFingerprint = "b".repeat(64);

function material() {
  return {
    contract_version: 1,
    provider: "square",
    operation_kind: "create_booking",
    api_version: API_VERSION,
    salon_id: SALON_ID,
    booking_id: BOOKING_ID,
    booking_service_id: SERVICE_ID,
    service_mapping_basis: "manicure",
    booking_staff_id: STAFF_ID,
    booking_status: BOOKING.status,
    booking_deleted_at: null,
    start_time_utc: BOOKING.start_time_utc,
    end_time_utc: BOOKING.end_time_utc,
    duration_minutes: 30,
    service_deleted_at: null,
    service_square_catalog_item_id: null,
    staff_status: "active",
    staff_deleted_at: null,
    square_team_member_id: "team-member-1",
    square_service_variation_id: "variation-1",
    square_service_variation_version: 7,
    provider_environment: config.environment,
    provider_application_id: config.applicationId,
    provider_merchant_id: config.merchantId,
    provider_location_id: config.locationId,
    provider_account_fingerprint: accountFingerprint,
    contact_fingerprint: contactFingerprint,
    provider_correlation_key: `NailIQ booking:${BOOKING_ID}`,
    customer_idempotency_key: `sqcust:${BOOKING_ID}`,
    booking_idempotency_key: `create:${BOOKING_ID}`,
  };
}

function claimPayload(code: "operation_claimed" | "reconciliation_claimed") {
  return {
    success: true,
    code,
    operation_id: OPERATION_ID,
    attempt_token: ATTEMPT_TOKEN,
    material: material(),
    material_fingerprint: materialFingerprint,
    contact_fingerprint: contactFingerprint,
    provider_account_fingerprint: accountFingerprint,
    customer_idempotency_key: `sqcust:${BOOKING_ID}`,
    booking_idempotency_key: `create:${BOOKING_ID}`,
    provider_correlation_key: `NailIQ booking:${BOOKING_ID}`,
  };
}

function dispatchPayload() {
  return {
    success: true,
    code: "dispatch_authorized",
    operation_id: OPERATION_ID,
    attempt_token: ATTEMPT_TOKEN,
    material_fingerprint: materialFingerprint,
    provider_material: {
      ...material(),
      client_name: BOOKING.client_name,
      client_phone: BOOKING.client_phone,
      client_email: BOOKING.client_email,
      seller_note: `NailIQ booking:${BOOKING_ID}`,
      customer_reference_id: `booking:${BOOKING_ID}`,
    },
  };
}

type OperationStatus = "none" | "claimed" | "sending" | "unknown" | "succeeded";

function database(input?: {
  completionFailures?: number;
  commitCompletionBeforeError?: boolean;
  blockClaimAfterUnknown?: boolean;
  changeContactBeforeDispatch?: boolean;
}) {
  let squareBookingId: string | null = null;
  let status: OperationStatus = "none";
  let completionAttempts = 0;
  let lastErrorClears = 0;
  let localInserts = 0;
  let providerCustomerId: string | null = null;
  let providerReceiptId: string | null = null;
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const from = vi.fn((table: string) => {
    let selected = "";
    let mutation: Record<string, unknown> | null = null;
    const filters = new Map<string, unknown>();
    let insertMutation = false;
    const exactBooking = () => ({ ...BOOKING, square_booking_id: squareBookingId });

    const list = async () => {
      if (table === "square_booking_writeback_operations") {
        return {
          data: ["sending", "unknown"].includes(status) ? [{
            booking_id: BOOKING_ID,
            status,
            material: material(),
            material_fingerprint: materialFingerprint,
            provider_account_fingerprint: accountFingerprint,
            provider_customer_id: providerCustomerId,
            provider_booking_id: providerReceiptId,
          }] : [],
          error: null,
        };
      }
      if (table === "services") {
        return { data: [{ id: SERVICE_ID, name: "Manicure", price_cents: 4_000 }], error: null };
      }
      if (table === "staff") {
        return { data: [
          { id: STAFF_ID, square_team_member_id: "team-member-1" },
          { id: "77777777-7777-4777-8777-777777777777", square_team_member_id: "team-member-2" },
        ], error: null };
      }
      if (table === "bookings") {
        if (selected.startsWith("staff_id, start_time_utc")) {
          return { data: [{
            staff_id: STAFF_ID,
            start_time_utc: BOOKING.start_time_utc,
            end_time_utc: BOOKING.end_time_utc,
            status: BOOKING.status,
          }], error: null };
        }
        if (selected.includes("client_name")) {
          return { data: squareBookingId ? [] : [exactBooking()], error: null };
        }
        return { data: [], error: null };
      }
      if (table === "square_integrations" && mutation?.last_error === null) lastErrorClears += 1;
      return { data: [], error: null };
    };

    const single = async () => {
      if (table !== "bookings") return { data: null, error: null };
      if (insertMutation) {
        localInserts += 1;
        return { data: { id: "duplicate-local-booking" }, error: null };
      }
      if (filters.get("id") === BOOKING_ID) return { data: exactBooking(), error: null };
      if (filters.get("square_booking_id") === SQUARE_BOOKING_ID && squareBookingId) {
        return { data: exactBooking(), error: null };
      }
      return { data: null, error: null };
    };

    const query = {
      select: (columns = "*") => { selected = columns; return query; },
      insert: () => { insertMutation = true; return query; },
      update: (values: Record<string, unknown>) => { mutation = values; return query; },
      upsert: () => query,
      delete: () => query,
      eq: (column: string, value: unknown) => { filters.set(column, value); return query; },
      in: () => query,
      is: () => query,
      not: () => query,
      gt: () => query,
      gte: () => query,
      lt: () => query,
      order: () => query,
      limit: () => query,
      range: () => query,
      maybeSingle: single,
      single,
      then: <TResult1 = Awaited<ReturnType<typeof list>>, TResult2 = never>(
        onfulfilled?: ((value: Awaited<ReturnType<typeof list>>) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => list().then(onfulfilled, onrejected),
    };
    return query;
  });

  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args: structuredClone(args) });
    if (fn === "claim_square_booking_writeback") {
      if (status === "none") {
        status = "claimed";
        return { data: claimPayload("operation_claimed"), error: null };
      }
      if (status === "unknown" && input?.blockClaimAfterUnknown) {
        return { data: { success: false, code: "operation_blocked" }, error: null };
      }
      return { data: {
        success: false,
        code: status === "succeeded" ? "operation_succeeded" : "reconciliation_required",
      }, error: null };
    }
    if (fn === "begin_square_booking_writeback_dispatch") {
      if (input?.changeContactBeforeDispatch) {
        status = "unknown";
        return { data: { success: false, code: "material_changed" }, error: null };
      }
      status = "sending";
      return { data: dispatchPayload(), error: null };
    }
    if (fn === "record_square_booking_writeback_customer") {
      providerCustomerId = String(args.p_provider_customer_id);
      return { data: {
        success: true,
        code: "customer_recorded",
        operation_id: OPERATION_ID,
        provider_customer_id: providerCustomerId,
      }, error: null };
    }
    if (fn === "mark_square_booking_writeback_unknown") {
      if (status === "succeeded") {
        return { data: { success: true, code: "operation_succeeded" }, error: null };
      }
      status = "unknown";
      providerCustomerId ||= args.p_provider_customer_id == null ? null : String(args.p_provider_customer_id);
      providerReceiptId ||= args.p_provider_booking_id == null ? null : String(args.p_provider_booking_id);
      return { data: { success: true, code: "operation_unknown" }, error: null };
    }
    if (fn === "claim_square_booking_writeback_reconciliation") {
      if (status !== "unknown") {
        return { data: { success: false, code: "reconciliation_not_available" }, error: null };
      }
      status = "sending";
      return { data: {
        ...claimPayload("reconciliation_claimed"),
        provider_customer_id: providerCustomerId,
        provider_booking_id: providerReceiptId,
        provider_booking_version: providerReceiptId ? 9 : null,
      }, error: null };
    }
    if (fn === "complete_square_booking_writeback_success") {
      completionAttempts += 1;
      providerCustomerId = String(args.p_provider_customer_id);
      providerReceiptId = String(args.p_provider_booking_id);
      if (completionAttempts <= (input?.completionFailures ?? 0)) {
        status = "unknown";
        return { data: { success: false, code: "local_bind_failed" }, error: null };
      }
      status = "succeeded";
      squareBookingId = providerReceiptId;
      const success = {
        success: true,
        code: "operation_completed",
        operation_id: OPERATION_ID,
        provider_booking_id: providerReceiptId,
        provider_customer_id: providerCustomerId,
      };
      if (input?.commitCompletionBeforeError) {
        return { data: null, error: { message: "response lost after commit" } };
      }
      return { data: success, error: null };
    }
    return { data: null, error: { message: `unexpected RPC ${fn}` } };
  });

  return {
    db: { from, rpc } as unknown as LooseDb,
    get squareBookingId() { return squareBookingId; },
    get operationStatus() { return status; },
    get lastErrorClears() { return lastErrorClears; },
    get localInserts() { return localInserts; },
    rpcCalls,
  };
}

describe("durable Square reverse-create binding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.resetAllMocks();
    mocks.getSquareConfig.mockResolvedValue(config);
    mocks.listBookings.mockResolvedValue([]);
    mocks.listCatalogItems.mockResolvedValue([{
      id: "catalog-item-1",
      name: "Manicure",
      variations: [{ id: "variation-1", version: 7 }],
    }]);
    mocks.ensureSquareCustomer.mockResolvedValue(SQUARE_CUSTOMER_ID);
  });

  afterEach(() => vi.useRealTimers());

  it("recovers provider success after a failed atomic bind without importing a duplicate", async () => {
    const state = database({ completionFailures: 1 });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValueOnce([]).mockResolvedValueOnce([{
      ...providerBooking,
      seller_note: undefined,
    }]);
    mocks.createSquareBooking.mockResolvedValue({ id: SQUARE_BOOKING_ID, version: 9 });

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_booking_bind_outcome_unknown",
    );
    expect(state.squareBookingId).toBeNull();
    expect(state.operationStatus).toBe("unknown");
    expect(state.lastErrorClears).toBe(0);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      pulled: 1,
      inserted: 0,
      createdInSquare: 0,
    });
    expect(mocks.createSquareBooking).toHaveBeenCalledTimes(1);
    expect(state.squareBookingId).toBe(SQUARE_BOOKING_ID);
    expect(state.localInserts).toBe(0);
    expect(state.lastErrorClears).toBe(1);
    expect(state.rpcCalls.some(({ fn }) => fn === "claim_square_booking_writeback_reconciliation")).toBe(true);
  });

  it("keeps an ambiguous CreateBooking outcome unknown until exact read-only recovery", async () => {
    const state = database();
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValueOnce([]).mockResolvedValueOnce([providerBooking]);
    mocks.createSquareBooking.mockRejectedValueOnce(
      new TypeError("connection reset after Square accepted the request"),
    );

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_booking_create_outcome_unknown",
    );
    expect(state.operationStatus).toBe("unknown");
    expect(state.squareBookingId).toBeNull();
    expect(state.lastErrorClears).toBe(0);
    expect(state.rpcCalls.find(({ fn }) => (
      fn === "mark_square_booking_writeback_unknown"
    ))?.args.p_error_code).toBe("square_booking_create_outcome_unknown");
    expect(JSON.stringify(state.rpcCalls)).not.toContain("connection reset");

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      pulled: 1,
      inserted: 0,
      createdInSquare: 0,
    });
    expect(mocks.createSquareBooking).toHaveBeenCalledTimes(1);
    expect(state.squareBookingId).toBe(SQUARE_BOOKING_ID);
  });

  it("does not complete or bind a malformed 200 CreateBooking receipt", async () => {
    const state = database();
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.createSquareBooking.mockRejectedValueOnce(
      new Error("Square CreateBooking returned no exact receipt"),
    );

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_booking_create_outcome_unknown",
    );
    expect(state.operationStatus).toBe("unknown");
    expect(state.squareBookingId).toBeNull();
    expect(state.lastErrorClears).toBe(0);
    expect(state.rpcCalls.some(({ fn }) => (
      fn === "complete_square_booking_writeback_success"
    ))).toBe(false);
  });

  it("does not import a possible lost create after Square-side material changes", async () => {
    const state = database();
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValueOnce([]).mockResolvedValueOnce([{
      ...providerBooking,
      seller_note: undefined,
      start_at: "2026-08-24T18:00:00.000Z",
    }]);
    mocks.createSquareBooking.mockRejectedValueOnce(
      new TypeError("connection reset after Square accepted the request"),
    );

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_booking_create_outcome_unknown",
    );
    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_booking_writeback_correlation_material_changed",
    );

    expect(mocks.createSquareBooking).toHaveBeenCalledTimes(1);
    expect(state.localInserts).toBe(0);
    expect(state.squareBookingId).toBeNull();
    expect(state.lastErrorClears).toBe(0);
  });

  it("blocks a new provider context after create instead of blind-posting again", async () => {
    const state = database({ completionFailures: 1, blockClaimAfterUnknown: true });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([]);
    mocks.createSquareBooking.mockResolvedValue({ id: SQUARE_BOOKING_ID, version: 9 });

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_booking_bind_outcome_unknown",
    );
    mocks.getSquareConfig.mockResolvedValue({
      ...config,
      locationId: "location-reconnected",
      accessToken: "new-account-token",
    });
    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_booking_writeback_provider_context_changed",
    );

    expect(mocks.createSquareBooking).toHaveBeenCalledTimes(1);
    expect(state.squareBookingId).toBeNull();
    expect(state.operationStatus).toBe("unknown");
    expect(state.lastErrorClears).toBe(0);
  });

  it("fails closed on a concurrent contact edit before any provider mutation", async () => {
    const state = database({ changeContactBeforeDispatch: true });
    mocks.looseServiceClient.mockReturnValue(state.db);

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_writeback_dispatch_failed",
    );
    expect(mocks.ensureSquareCustomer).not.toHaveBeenCalled();
    expect(mocks.createSquareBooking).not.toHaveBeenCalled();
    expect(state.squareBookingId).toBeNull();
  });

  it("does not report success when the atomic completion response is lost", async () => {
    const state = database({ commitCompletionBeforeError: true });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValueOnce([]).mockResolvedValueOnce([providerBooking]);
    mocks.createSquareBooking.mockResolvedValue({ id: SQUARE_BOOKING_ID, version: 9 });

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_booking_bind_outcome_unknown",
    );
    expect(state.squareBookingId).toBe(SQUARE_BOOKING_ID);
    expect(state.operationStatus).toBe("succeeded");
    expect(state.lastErrorClears).toBe(0);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      pulled: 1,
      inserted: 0,
      createdInSquare: 0,
    });
    expect(mocks.createSquareBooking).toHaveBeenCalledTimes(1);
    expect(state.lastErrorClears).toBe(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/shared/dashboard/sendOwnerBookingNotification", () => ({
  sendOwnerBookingNotification: vi.fn(),
}));
vi.mock("../looseDb", () => ({ looseServiceClient: mocks.looseServiceClient }));
vi.mock("../client", () => ({
  SQUARE_API_VERSION: "2024-12-18",
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
import type { SquareBooking, SquareConfig } from "../client";
import type { LooseDb } from "../looseDb";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const BOOKING_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "33333333-3333-4333-8333-333333333333";
const STAFF_ID = "44444444-4444-4444-8444-444444444444";
const SQUARE_BOOKING_ID = "square-booking-1";
const ORIGINAL_START = "2026-08-24T17:00:00.000Z";
const ORIGINAL_END = "2026-08-24T17:30:00.000Z";

const baseConfig: SquareConfig = {
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

const providerBooking = (overrides: Partial<SquareBooking> = {}): SquareBooking => ({
  id: SQUARE_BOOKING_ID,
  version: 4,
  status: "ACCEPTED",
  location_id: baseConfig.locationId,
  seller_note: `NailIQ booking:${BOOKING_ID}`,
  start_at: ORIGINAL_START,
  updated_at: "2026-08-22T08:00:00.000Z",
  appointment_segments: [{
    duration_minutes: 30,
    team_member_id: "team-member-1",
    service_variation_id: "variation-1",
    service_variation_version: 7,
  }],
  ...overrides,
});

type LocalBooking = Record<string, unknown> & {
  id: string;
  salon_id: string;
  square_booking_id: string;
  status: string;
  start_time_utc: string;
  end_time_utc: string;
};

function lifecycleDatabase(overrides: Partial<LocalBooking> = {}) {
  const local: LocalBooking = {
    id: BOOKING_ID,
    salon_id: SALON_ID,
    service_id: SERVICE_ID,
    staff_id: STAFF_ID,
    square_booking_id: SQUARE_BOOKING_ID,
    client_name: "QA Guest",
    client_phone: "+16045550101",
    client_email: "qa@nailiq.invalid",
    status: "confirmed",
    deleted_at: null,
    start_time_utc: ORIGINAL_START,
    end_time_utc: ORIGINAL_END,
    local_updated_at: null,
    rescheduled_at: null,
    ...overrides,
  };

  const from = vi.fn((table: string) => {
    let selected = "";
    let mutation: Record<string, unknown> | null = null;
    const filters = new Map<string, unknown>();

    const list = async () => {
      if (table === "services") {
        return { data: [{ id: SERVICE_ID, name: "Manicure", price_cents: 4_000 }], error: null };
      }
      if (table === "staff") {
        return { data: [{ id: STAFF_ID, square_team_member_id: "team-member-1" }], error: null };
      }
      if (table === "bookings") {
        if (mutation) {
          Object.assign(local, mutation);
          return { data: [], error: null };
        }
        if (selected.startsWith("staff_id, start_time_utc")) {
          return { data: [{
            staff_id: STAFF_ID,
            start_time_utc: local.start_time_utc,
            end_time_utc: local.end_time_utc,
            status: local.status,
          }], error: null };
        }
        if (selected === "id, square_booking_id") {
          return { data: local.status === "cancelled" ? [{
            id: local.id,
            square_booking_id: local.square_booking_id,
          }] : [], error: null };
        }
        if (selected.includes("local_updated_at") && selected.includes("square_booking_id")) {
          return { data: [structuredClone(local)], error: null };
        }
        if (selected.includes("client_name")) return { data: [], error: null };
        return { data: [], error: null };
      }
      if (table === "square_integrations" && mutation) Object.assign(local, {});
      return { data: [], error: null };
    };

    const single = async () => {
      if (table !== "bookings") return { data: null, error: null };
      const byId = filters.get("id") === BOOKING_ID;
      const bySquareId = filters.get("square_booking_id") === SQUARE_BOOKING_ID;
      if (!byId && !bySquareId) return { data: null, error: null };
      if (mutation) Object.assign(local, mutation);
      return { data: structuredClone(local), error: null };
    };

    const query = {
      select: (columns = "*") => { selected = columns; return query; },
      insert: () => query,
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

  return {
    db: { from, rpc: vi.fn() } as unknown as LooseDb,
    local,
  };
}

describe("already-bound NailIQ-tagged Square booking lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSquareConfig.mockResolvedValue(baseConfig);
    mocks.listCatalogItems.mockResolvedValue([{
      id: "catalog-item-1",
      name: "Manicure",
      variations: [{ id: "variation-1", version: 7 }],
    }]);
  });

  it("continues to the normal local-cancel push on the third run", async () => {
    const state = lifecycleDatabase({ status: "cancelled" });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.getSquareConfig.mockResolvedValue({
      ...baseConfig,
      sync: { ...baseConfig.sync, pushCancel: true },
    });
    mocks.listBookings.mockResolvedValue([providerBooking()]);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      cancelledInSquare: 1,
      inserted: 0,
    });
    expect(mocks.cancelSquareBooking).toHaveBeenCalledWith(
      expect.anything(),
      SQUARE_BOOKING_ID,
      4,
    );
  });

  it("preserves a desk-completed booking instead of re-entering create recovery", async () => {
    const state = lifecycleDatabase({ status: "completed" });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([providerBooking()]);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      inserted: 0,
      updated: 0,
      createdInSquare: 0,
    });
    expect(state.local.status).toBe("completed");
    expect(mocks.createSquareBooking).not.toHaveBeenCalled();
  });

  it("continues to the normal local-reschedule push on the third run", async () => {
    const state = lifecycleDatabase({
      start_time_utc: "2026-08-24T18:00:00.000Z",
      end_time_utc: "2026-08-24T18:30:00.000Z",
      local_updated_at: "2026-08-22T10:00:00.000Z",
      rescheduled_at: "2026-08-22T10:00:00.000Z",
    });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.getSquareConfig.mockResolvedValue({
      ...baseConfig,
      sync: { ...baseConfig.sync, pushUpdate: true },
    });
    mocks.listBookings.mockResolvedValue([providerBooking()]);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      updatedInSquare: 1,
      inserted: 0,
    });
    expect(mocks.updateSquareBookingTime).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        bookingId: SQUARE_BOOKING_ID,
        startAtIso: "2026-08-24T18:00:00.000Z",
      }),
    );
  });

  it("applies a Square-side cancellation through the normal forward path", async () => {
    const state = lifecycleDatabase();
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([providerBooking({
      status: "CANCELLED_BY_CUSTOMER",
    })]);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      updated: 1,
      inserted: 0,
    });
    expect(state.local.status).toBe("cancelled");
    expect(mocks.createSquareBooking).not.toHaveBeenCalled();
  });

  it("applies a newer Square-side reschedule through the normal forward path", async () => {
    const state = lifecycleDatabase();
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([providerBooking({
      start_at: "2026-08-24T18:00:00.000Z",
      updated_at: "2026-08-22T12:00:00.000Z",
    })]);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      updated: 1,
      inserted: 0,
    });
    expect(state.local.start_time_utc).toBe("2026-08-24T18:00:00.000Z");
    expect(state.local.end_time_utc).toBe("2026-08-24T18:30:00.000Z");
    expect(mocks.createSquareBooking).not.toHaveBeenCalled();
  });

  it("fails closed when the tagged local booking is bound to a different provider ID", async () => {
    const state = lifecycleDatabase({ square_booking_id: "square-booking-other" });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([providerBooking()]);

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_create_correlation_binding_conflict",
    );
    expect(mocks.createSquareBooking).not.toHaveBeenCalled();
    expect(mocks.cancelSquareBooking).not.toHaveBeenCalled();
    expect(mocks.updateSquareBookingTime).not.toHaveBeenCalled();
  });
});

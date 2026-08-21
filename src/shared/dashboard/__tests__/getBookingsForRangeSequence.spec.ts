import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
  getDashboardWriteClient: vi.fn(),
}));

vi.mock("@/shared/observability/errorReporter", () => ({
  startSpan: (_options: unknown, work: () => unknown) => work(),
}));
vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.getDashboardWriteClient,
}));

import { getBookingsForRangeAction } from "../getBookingsForRangeAction";
import {
  calendarBookingTargetId,
  groupCalendarRowsByDay,
} from "../calendarBookingRows";

function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "gte", "lt", "in", "is"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.order = vi.fn(async () => result);
  chain.maybeSingle = vi.fn(async () => result);
  return chain;
}

describe("segment-aware calendar range", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits every later sequence line once with exact capacity attribution", () => {
    const result = groupCalendarRowsByDay(
      [{
        id: "single-1",
        client_name: "Single guest",
        start_time_utc: "2026-08-21T17:00:00.000Z",
        end_time_utc: "2026-08-21T17:30:00.000Z",
        staff_id: "staff-a",
        resource_id: null,
        status: "confirmed",
        schedule_model: "single",
        services: { name: "Manicure" },
      }, {
        id: "sequence-parent",
        client_name: "Sequence guest",
        start_time_utc: "2026-08-21T18:00:00.000Z",
        end_time_utc: "2026-08-21T19:00:00.000Z",
        staff_id: "staff-a",
        resource_id: "room-1",
        status: "confirmed",
        schedule_model: "segments_v1",
        services: { name: "Prep service" },
      }],
      [{
        id: "segment-1",
        booking_id: "sequence-parent",
        position: 0,
        staff_id: "staff-a",
        resource_id: "room-1",
        service_name: "Prep service",
        customer_start_utc: "2026-08-21T18:00:00.000Z",
        customer_end_utc: "2026-08-21T18:30:00.000Z",
        occupied_start_utc: "2026-08-21T17:50:00.000Z",
        occupied_end_utc: "2026-08-21T18:35:00.000Z",
        prep_minutes: 10,
        reservation_status: "confirmed",
        booking: { client_name: "Sequence guest", status: "confirmed", schedule_model: "segments_v1" },
      }, {
        id: "segment-2",
        booking_id: "sequence-parent",
        position: 1,
        staff_id: "staff-b",
        resource_id: "room-2",
        service_name: "Later service",
        customer_start_utc: "2026-08-21T18:30:00.000Z",
        customer_end_utc: "2026-08-21T19:00:00.000Z",
        occupied_start_utc: "2026-08-21T18:25:00.000Z",
        occupied_end_utc: "2026-08-21T19:05:00.000Z",
        prep_minutes: 5,
        reservation_status: "confirmed",
        booking: { client_name: "Sequence guest", status: "confirmed", schedule_model: "segments_v1" },
      }],
      "UTC",
    );

    const rows = result.days["2026-08-21"];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.calendar_entry_id)).toEqual([
      "single-1",
      "segment-1",
      "segment-2",
    ]);
    expect(rows.filter((row) => row.booking_id === "sequence-parent")).toHaveLength(2);
    expect(rows[2]).toMatchObject({
      id: "sequence-parent",
      segment_id: "segment-2",
      position: 1,
      staff_id: "staff-b",
      resource_id: "room-2",
      prep_minutes: 5,
      occupied_start_time_utc: "2026-08-21T18:25:00.000Z",
      occupied_end_time_utc: "2026-08-21T19:05:00.000Z",
    });
    expect(calendarBookingTargetId(rows[2])).toBe("sequence-parent");
  });

  it("tenant-scopes both reads and fails closed when the segment query fails", async () => {
    const member = query({ data: { salon_id: "salon-a" }, error: null });
    const bookings = query({ data: [], error: null });
    const segments = query({ data: null, error: { message: "segment read failed" } });
    const userClient = {
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
      rpc: vi.fn(async () => ({ data: true, error: null })),
      from: vi.fn(() => member),
    };
    const serviceClient = {
      from: vi.fn((table: string) => table === "bookings" ? bookings : segments),
    };
    mocks.createClient.mockResolvedValue(userClient);
    mocks.createServiceRoleClient.mockReturnValue(serviceClient);

    const result = await getBookingsForRangeAction(
      "salon-a",
      "2026-08-21",
      "2026-08-21",
      { salonId: "salon-a", timezone: "UTC" },
    );

    expect(result).toEqual({ ok: false, error: "server_error" });
    expect(bookings.eq).toHaveBeenCalledWith("salon_id", "salon-a");
    expect(bookings.eq).toHaveBeenCalledWith("schedule_model", "single");
    expect(segments.eq).toHaveBeenCalledWith("salon_id", "salon-a");
    expect(segments.eq).toHaveBeenCalledWith("booking.salon_id", "salon-a");
    expect(segments.eq).toHaveBeenCalledWith("booking.schedule_model", "segments_v1");
  });
});

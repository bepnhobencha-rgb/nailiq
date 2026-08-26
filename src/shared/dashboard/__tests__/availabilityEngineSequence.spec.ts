import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  getDashboardWriteClient: vi.fn(),
}));

vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.getDashboardWriteClient,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import { getStaffAvailability } from "../availabilityEngine";

function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "lte", "or", "is", "order"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (
    resolve: (value: { data: unknown; error: unknown }) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain as Record<string, ReturnType<typeof vi.fn>>;
}

describe("segment-aware operational availability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T18:27:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("attributes a later segment's prep occupancy to its exact staff/resource without parent double-counting", async () => {
    const staff = query({
      data: [
        { id: "staff-a", name: "Ana", status: "active" },
        { id: "staff-b", name: "Bao", status: "active" },
        { id: "staff-c", name: "Cai", status: "active" },
      ],
      error: null,
    });
    const bookings = query({
      data: [{
        id: "sequence-parent",
        staff_id: "staff-a",
        resource_id: "room-1",
        client_name: "Sequence guest",
        status: "confirmed",
        start_time_utc: "2026-08-21T18:00:00.000Z",
        end_time_utc: "2026-08-21T19:00:00.000Z",
        staff_request_note: null,
        group_id: null,
        schedule_model: "segments_v1",
      }],
      error: null,
    });
    const segments = query({
      data: [{
        id: "segment-1",
        booking_id: "sequence-parent",
        staff_id: "staff-a",
        resource_id: "room-1",
        prep_minutes: 10,
        customer_start_utc: "2026-08-21T18:00:00.000Z",
        customer_end_utc: "2026-08-21T18:20:00.000Z",
        occupied_start_utc: "2026-08-21T17:50:00.000Z",
        occupied_end_utc: "2026-08-21T18:25:00.000Z",
        reservation_status: "confirmed",
        booking: { client_name: "Sequence guest", group_id: null, schedule_model: "segments_v1" },
      }, {
        id: "segment-2",
        booking_id: "sequence-parent",
        staff_id: "staff-b",
        resource_id: "room-2",
        prep_minutes: 5,
        customer_start_utc: "2026-08-21T18:30:00.000Z",
        customer_end_utc: "2026-08-21T19:00:00.000Z",
        occupied_start_utc: "2026-08-21T18:25:00.000Z",
        occupied_end_utc: "2026-08-21T19:05:00.000Z",
        reservation_status: "confirmed",
        booking: { client_name: "Sequence guest", group_id: null, schedule_model: "segments_v1" },
      }, {
        id: "segment-overrun",
        booking_id: "sequence-parent",
        staff_id: "staff-c",
        resource_id: "room-3",
        prep_minutes: 0,
        customer_start_utc: "2026-08-21T18:00:00.000Z",
        customer_end_utc: "2026-08-21T18:20:00.000Z",
        occupied_start_utc: "2026-08-21T18:00:00.000Z",
        occupied_end_utc: "2026-08-21T18:25:00.000Z",
        reservation_status: "in_progress",
        booking: { client_name: "Overrun guest", group_id: null, schedule_model: "segments_v1" },
      }],
      error: null,
    });
    const queueRows = query({ data: [], error: null });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "staff") return staff;
        if (table === "bookings" && supabase.from.mock.calls.filter(([name]) => name === "bookings").length === 1) {
          return bookings;
        }
        return queueRows;
      }),
    };
    const serviceRole = {
      from: vi.fn(() => segments),
    };
    mocks.createServiceRoleClient.mockReturnValue(serviceRole);
    mocks.getDashboardWriteClient.mockResolvedValue({
      salon: { id: "salon-a" },
      supabase,
    });

    const result = await getStaffAvailability("salon-a", null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ana = result.staff.find((row) => row.staffId === "staff-a")!;
    const bao = result.staff.find((row) => row.staffId === "staff-b")!;
    const cai = result.staff.find((row) => row.staffId === "staff-c")!;
    // A stale confirmed reservation ended before now and must not inflate load.
    expect(ana.reservations).toHaveLength(0);
    expect(ana.isAvailableNow).toBe(true);
    expect(bao.reservations).toHaveLength(1);
    expect(bao.bookingsNext2h).toBe(1);
    expect(bao.currentBooking).toMatchObject({
      bookingId: "sequence-parent",
      reservationId: "segment-2",
      segmentId: "segment-2",
      scheduleModel: "segments_v1",
      staffId: "staff-b",
      resourceId: "room-2",
      prepMinutes: 5,
      serviceStartsAt: "2026-08-21T18:30:00.000Z",
      occupiedStartsAt: "2026-08-21T18:25:00.000Z",
      occupiedEndsAt: "2026-08-21T19:05:00.000Z",
    });
    // An explicitly in-progress reservation remains visible after its planned end
    // so the existing overrun projection can fail safe.
    expect(cai.reservations).toHaveLength(1);
    expect(cai.currentBooking).toMatchObject({
      reservationId: "segment-overrun",
      scheduleModel: "segments_v1",
      staffId: "staff-c",
      resourceId: "room-3",
    });
    expect(bookings.eq).toHaveBeenCalledWith("salon_id", "salon-a");
    expect(bookings.eq).toHaveBeenCalledWith("schedule_model", "single");
    expect(segments.eq).toHaveBeenCalledWith("salon_id", "salon-a");
    expect(segments.eq).toHaveBeenCalledWith("booking.salon_id", "salon-a");
    expect(segments.eq).toHaveBeenCalledWith("booking.schedule_model", "segments_v1");
    expect(bookings.or).toHaveBeenCalledWith(
      "status.eq.in_progress,end_time_utc.gte.2026-08-21T18:27:00.000Z",
    );
    expect(segments.or).toHaveBeenCalledWith(
      "reservation_status.eq.in_progress,occupied_end_utc.gte.2026-08-21T18:27:00.000Z",
    );
    expect(serviceRole.from).toHaveBeenCalledWith("booking_service_segments");
  });

  it("fails closed when tenant-scoped segment capacity cannot be loaded", async () => {
    const staff = query({
      data: [{ id: "staff-a", name: "Ana", status: "active" }],
      error: null,
    });
    const bookings = query({ data: [], error: null });
    const segments = query({ data: null, error: { message: "denied" } });
    const supabase = {
      from: vi.fn((table: string) => table === "staff" ? staff : bookings),
    };
    mocks.createServiceRoleClient.mockReturnValue({
      from: vi.fn(() => segments),
    });
    mocks.getDashboardWriteClient.mockResolvedValue({
      salon: { id: "salon-a" },
      supabase,
    });

    const result = await getStaffAvailability("salon-a", null);

    expect(result).toEqual({ ok: false, error: "server_error" });
    expect(segments.eq).toHaveBeenCalledWith("salon_id", "salon-a");
    expect(segments.eq).toHaveBeenCalledWith("booking.salon_id", "salon-a");
  });
});

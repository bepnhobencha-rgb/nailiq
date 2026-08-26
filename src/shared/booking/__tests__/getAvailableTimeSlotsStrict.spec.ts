import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/publicClient", () => ({
  createPublicClient: mocks.createPublicClient,
}));

import {
  getAvailableTimeSlots,
  getAvailableTimeSlotsStrict,
} from "@/shared/booking/getAvailableTimeSlots";

const HOURS = {
  mon: { open: "09:00", close: "18:00", closed: false },
  tue: { open: "09:00", close: "18:00", closed: false },
  wed: { open: "09:00", close: "18:00", closed: false },
  thu: { open: "09:00", close: "18:00", closed: false },
  fri: { open: "09:00", close: "18:00", closed: false },
  sat: { open: "09:00", close: "18:00", closed: false },
  sun: { open: "09:00", close: "18:00", closed: false },
};

const params = {
  salonId: "salon-1",
  openingHoursRaw: HOURS,
  selectedDate: new Date(2099, 0, 5, 12, 0, 0),
  staffId: "any",
  staffList: [{ id: "staff-1", name: "Jenny", job_role: "nail_tech" }],
  serviceDurationMinutes: 45,
  timezone: "America/Vancouver",
};

function query(result: { data: unknown; error: unknown }) {
  const chain = {
    eq: vi.fn(),
    then: (
      resolve: (value: { data: unknown; error: unknown }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };
  chain.eq.mockReturnValue(chain);
  return chain;
}

function client(options?: {
  occupancy?: { data: unknown; error: unknown };
  shifts?: { data: unknown; error: unknown };
  unavailable?: { data: unknown; error: unknown };
  throwTable?: string;
}) {
  const occupancy = options?.occupancy ?? { data: [], error: null };
  const shifts = options?.shifts ?? { data: [], error: null };
  const unavailable = options?.unavailable ?? { data: [], error: null };
  return {
    rpc: vi.fn().mockResolvedValue(occupancy),
    from: vi.fn((table: string) => {
      if (options?.throwTable === table) throw new Error("query unavailable");
      const result = table === "public_staff_shifts" ? shifts : unavailable;
      return {
        select: vi.fn(() => query(result)),
      };
    }),
  };
}

describe("getAvailableTimeSlotsStrict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPublicClient.mockReturnValue(client());
  });

  it("returns computed slots only after every availability read succeeds", async () => {
    const result = await getAvailableTimeSlotsStrict(params);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected strict availability");
    expect(result.slots.some((slot) => slot.available)).toBe(true);
  });

  it("accepts PostgreSQL time strings for configured staff breaks", async () => {
    mocks.createPublicClient.mockReturnValue(
      client({
        shifts: {
          data: [
            {
              staff_id: "staff-1",
              start_time: "09:00",
              end_time: "18:00",
              break_start_time: "12:00:00",
              break_end_time: "12:30:00.000000",
            },
          ],
          error: null,
        },
      }),
    );
    const result = await getAvailableTimeSlotsStrict(params);
    expect(result.ok).toBe(true);
  });

  it.each([
    { data: null, error: { code: "rpc_down" } },
    { data: null, error: null },
  ] as const)("fails closed on an invalid occupancy result", async (occupancy) => {
    mocks.createPublicClient.mockReturnValue(client({ occupancy }));
    await expect(getAvailableTimeSlotsStrict(params)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("fails closed when shift or unavailability reads fail", async () => {
    mocks.createPublicClient.mockReturnValue(
      client({ shifts: { data: null, error: { code: "shift_down" } } }),
    );
    await expect(getAvailableTimeSlotsStrict(params)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });

    mocks.createPublicClient.mockReturnValue(
      client({ unavailable: { data: [], error: { code: "leave_down" } } }),
    );
    await expect(getAvailableTimeSlotsStrict(params)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it.each([
    [{}],
    [
      {
        staff_id: "staff-1",
        start_time_utc: "not-an-instant",
        end_time_utc: "2099-01-05T18:00:00.000Z",
      },
    ],
    [
      {
        staff_id: "staff-1",
        start_time_utc: "2099-01-05T18:00:00.000Z",
        end_time_utc: "2099-01-05T17:00:00.000Z",
      },
    ],
  ])("fails closed on malformed occupancy rows", async (data) => {
    mocks.createPublicClient.mockReturnValue(
      client({ occupancy: { data, error: null } }),
    );
    await expect(getAvailableTimeSlotsStrict(params)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it.each([
    {
      shifts: {
        data: [
          {
            staff_id: "staff-1",
            start_time: "25:00",
            end_time: "18:00",
            break_start_time: null,
            break_end_time: null,
          },
        ],
        error: null,
      },
    },
    {
      shifts: {
        data: [
          {
            staff_id: "staff-1",
            start_time: "09:00",
            end_time: "18:00",
            break_start_time: "12:00:60",
            break_end_time: "12:30:00",
          },
        ],
        error: null,
      },
    },
    {
      shifts: {
        data: [
          {
            staff_id: "staff-1",
            start_time: "09:00",
            end_time: "18:00",
            break_start_time: "12:00",
            break_end_time: null,
          },
        ],
        error: null,
      },
    },
    { unavailable: { data: [{}], error: null } },
  ])("fails closed on malformed shift or leave rows", async (options) => {
    mocks.createPublicClient.mockReturnValue(client(options));
    await expect(getAvailableTimeSlotsStrict(params)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("fails closed when the client or a table query throws", async () => {
    mocks.createPublicClient.mockImplementationOnce(() => {
      throw new Error("client unavailable");
    });
    await expect(getAvailableTimeSlotsStrict(params)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });

    mocks.createPublicClient.mockReturnValue(
      client({ throwTable: "public_staff_shifts" }),
    );
    await expect(getAvailableTimeSlotsStrict(params)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("preserves the legacy fail-open grid for existing callers", async () => {
    mocks.createPublicClient.mockReturnValue(
      client({ occupancy: { data: null, error: { code: "rpc_down" } } }),
    );
    const slots = await getAvailableTimeSlots(params);
    expect(slots.some((slot) => slot.available)).toBe(true);
  });
});

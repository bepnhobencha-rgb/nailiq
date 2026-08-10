import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: () => {} };
});

import { executeVoiceTool } from "../toolExecutor";

const SALON_ID = "00000000-0000-4000-8000-000000000001";
const PHONE = "16045551234";
const HOURS = {
  mon: { open: "09:00", close: "19:30", closed: false },
  tue: { open: "09:00", close: "19:30", closed: false },
  wed: { open: "09:00", close: "19:30", closed: false },
  thu: { open: "09:00", close: "19:30", closed: false },
  fri: { open: "09:00", close: "19:30", closed: false },
  sat: { open: "09:00", close: "19:30", closed: false },
  sun: { open: "09:00", close: "19:30", closed: false },
};

type Row = Record<string, unknown>;

function mockDb() {
  const rpcCalls: string[] = [];
  const fixtures: Record<string, Row[] | Row> = {
    salons: {
      id: SALON_ID,
      timezone: "UTC",
      opening_hours: HOURS,
      booking_closed_dates: [],
    },
    services: [
      {
        id: "svc-1",
        name: "Manicure",
        duration_minutes: 30,
        buffer_minutes: 10,
        price_cents: 3000,
      },
    ],
    staff: [
      { id: "staff-1", name: "Anna" },
      { id: "staff-2", name: "Bella" },
    ],
    staff_services: [],
  };

  const make = (table: string) => {
    const rows = fixtures[table];
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    const one = list[0] ?? null;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      is: () => chain,
      gte: () => chain,
      lt: () => chain,
      single: async () => ({ data: one, error: null }),
      maybeSingle: async () => ({ data: one, error: null }),
      then: (resolve: (value: unknown) => unknown) =>
        resolve({ data: list, error: null }),
    };
    return chain;
  };

  return {
    client: {
      from: (table: string) => make(table),
      rpc: async (name: string) => {
        rpcCalls.push(name);
        return { data: [], error: null };
      },
    } as never,
    rpcCalls,
  };
}

describe("Voice/SMS group confirmation opening-hours guard", () => {
  it("rejects a crafted sync_start after close before the insert RPC", async () => {
    const { client, rpcCalls } = mockDb();
    const response = await executeVoiceTool(
      client,
      "test-salon",
      "confirm_group_booking",
      {
        service_assignments: [{ service_id: "svc-1", count: 2 }],
        date: "2026-08-11",
        time: "20:00",
        mode: "sync_start",
        organizer_name: "Test Organizer",
        organizer_phone: PHONE,
      },
      null,
      "https://example.test",
      { callerVerifiedPhone: PHONE },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      reason: "outside_hours",
      member_number: 1,
    });
    expect(rpcCalls).toContain("public_booking_occupancy_for_range");
    expect(rpcCalls).not.toContain("insert_group_bookings");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const afterJobs = vi.hoisted(() => [] as Array<() => Promise<unknown>>);
const reconcileCommittedBooking = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (job: () => Promise<unknown>) => {
      afterJobs.push(job);
    },
  };
});
vi.mock("@/shared/booking/reconcileCommittedBooking", () => ({
  reconcileCommittedBooking,
}));

import { executeVoiceTool } from "@/shared/voiceai/toolExecutor";

const SALON = "11111111-1111-4111-8111-111111111111";
const SERVICE = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const FINGERPRINT = "a".repeat(64);

const quote = {
  success: true,
  pricing_fingerprint: FINGERPRINT,
  salon_id: SALON,
  service_id: SERVICE,
  staff_id: STAFF,
  start_time_utc: "2099-08-21T21:00:00.000Z",
  end_time_utc: "2099-08-21T22:00:00.000Z",
  combo_id: null,
  voucher_id: null,
  currency: "CAD",
  original_price_cents: 5_000,
  service_pre_voucher_cents: 5_000,
  price_cents: 5_000,
  addon_pre_voucher_cents: 0,
  addon_price_cents: 0,
  promo_id: null,
  promo_name: null,
  promo_discount_cents: 0,
  email_discount_cents: 0,
  voucher_discount_cents: 0,
  pre_voucher_subtotal_cents: 5_000,
  subtotal_cents: 5_000,
  tax_cents: 250,
  total_cents: 5_250,
  tax_breakdown: [{ name: "GST", rate: 0.05, amount_cents: 250 }],
  addon_lines: [],
};

function db(create: boolean | "changed" = false) {
  const rpc = vi.fn()
    .mockResolvedValueOnce({ data: quote, error: null });
  if (create === true) {
    rpc.mockResolvedValueOnce({
      data: { ...quote, success: true, code: "booked", booking_id: "44444444-4444-4444-8444-444444444444" },
      error: null,
    });
  } else if (create === "changed") {
    rpc.mockResolvedValueOnce({
      data: { success: false, code: "pricing_changed", quote },
      error: null,
    });
  }
  const fixtures: Record<string, unknown> = {
    salons: { id: SALON, timezone: "America/Vancouver", opening_hours: {}, booking_closed_dates: [] },
    services: { id: SERVICE, name: "Manicure", duration_minutes: 60, price_cents: 5_000 },
    staff: { id: STAFF, name: "Mai" },
  };
  const from = (table: string) => {
    const row = fixtures[table] ?? null;
    const chain: Record<string, unknown> = {
      select: () => chain, update: () => chain, eq: () => chain, is: () => chain,
      single: async () => ({ data: row, error: null }),
      maybeSingle: async () => ({ data: table === "bookings" ? null : row, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: row ? [row] : [], error: null }),
    };
    return chain;
  };
  return { client: { from, rpc } as never, rpc };
}

function replayDb(bookingOverrides: Record<string, unknown> = {}) {
  const rpc = vi.fn();
  const fixtures: Record<string, unknown> = {
    salons: { id: SALON, timezone: "America/Vancouver", opening_hours: {}, booking_closed_dates: [] },
    services: { id: SERVICE, name: "Manicure", duration_minutes: 60, price_cents: 5_000 },
    staff: { id: STAFF, name: "Mai" },
    bookings: {
      id: "44444444-4444-4444-8444-444444444444",
      status: "confirmed",
      service_id: SERVICE,
      staff_id: STAFF,
      client_name: "Test Customer",
      client_phone: "16045551234",
      start_time_utc: "2099-08-21T21:00:00.000Z",
      public_booking_pricing_fingerprint: FINGERPRINT,
      ...bookingOverrides,
    },
  };
  const from = (table: string) => {
    const row = fixtures[table] ?? null;
    const chain: Record<string, unknown> = {
      select: () => chain, eq: () => chain, is: () => chain,
      single: async () => ({ data: row, error: null }),
      maybeSingle: async () => ({ data: row, error: null }),
    };
    return chain;
  };
  return { client: { from, rpc } as never, rpc };
}

const args = {
  service_id: SERVICE,
  date: "2099-08-21",
  time_slot: "2:00 PM",
  staff_id: STAFF,
  customer_name: "Test Customer",
  customer_phone: "16045551234",
};

async function call(client: never, toolArgs: Record<string, unknown>, utterance: string) {
  const response = await executeVoiceTool(
    client,
    "qa-salon",
    "confirm_booking",
    toolArgs,
    "session-1",
    "https://nailiq.ca",
    { callerVerifiedPhone: "16045551234", trustedUserUtterance: utterance },
  );
  return response.json() as Promise<Record<string, unknown>>;
}

describe("voice booking two-stage authoritative price", () => {
  beforeEach(() => {
    afterJobs.length = 0;
    reconcileCommittedBooking.mockClear();
  });

  it("first call returns a sanitized quote and performs no create", async () => {
    const mocked = db();
    const result = await call(mocked.client, args, "yes");
    expect(result.error).toBe("pricing_confirmation_required");
    expect(result.requires_price_confirmation).toBe(true);
    expect(result.quote).toMatchObject({
      pricing_fingerprint: FINGERPRINT,
      currency: "CAD",
      total_cents: 5_250,
    });
    expect(mocked.rpc).toHaveBeenCalledTimes(1);
  });

  it("creates only when the exact fingerprint accompanies a new clear yes", async () => {
    const mocked = db(true);
    const result = await call(
      mocked.client,
      { ...args, confirmed_pricing_fingerprint: FINGERPRINT },
      "yes please",
    );
    expect(result.success).toBe(true);
    expect(mocked.rpc).toHaveBeenCalledTimes(2);
    expect(mocked.rpc.mock.calls[1]?.[1]).toMatchObject({
      p_expected_pricing_fingerprint: FINGERPRINT,
    });
  });

  it("fails closed on unclear consent even with the exact fingerprint", async () => {
    const mocked = db();
    const result = await call(
      mocked.client,
      { ...args, confirmed_pricing_fingerprint: FINGERPRINT },
      "maybe later",
    );
    expect(result.requires_price_confirmation).toBe(true);
    expect(mocked.rpc).toHaveBeenCalledTimes(1);
  });

  it("sends a stale confirmed fingerprint to create and returns its zero-write re-quote", async () => {
    const mocked = db("changed");
    const stale = "b".repeat(64);
    const result = await call(
      mocked.client,
      { ...args, confirmed_pricing_fingerprint: stale },
      "yes",
    );
    expect(result.error).toBe("pricing_changed");
    expect(result.requires_price_confirmation).toBe(true);
    expect(result.quote).toMatchObject({ pricing_fingerprint: FINGERPRINT });
    expect(mocked.rpc.mock.calls[1]?.[1]).toMatchObject({
      p_expected_pricing_fingerprint: stale,
    });
  });

  it("replays a committed Any-staff row before occupancy can re-resolve it", async () => {
    const mocked = replayDb();
    const result = await call(
      mocked.client,
      { ...args, staff_id: "any", confirmed_pricing_fingerprint: FINGERPRINT },
      "yes",
    );

    expect(result).toMatchObject({
      success: true,
      idempotent: true,
      bookingId: "44444444-4444-4444-8444-444444444444",
      staffName: "Mai",
    });
    expect(mocked.rpc).not.toHaveBeenCalled();
    expect(afterJobs).toHaveLength(1);
    await afterJobs[0]!();
    expect(reconcileCommittedBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "44444444-4444-4444-8444-444444444444",
        salonId: SALON,
        channel: "voice",
        protectionChannel: "voice",
      }),
    );
  });

  it.each([
    ["cancelled", "2099-08-21T21:00:00.000Z", "booking_cancelled"],
    ["completed", "2099-08-21T21:00:00.000Z", "booking_completed"],
    ["confirmed", "2099-08-22T21:00:00.000Z", "booking_rescheduled"],
  ])(
    "does not re-announce a %s/current-state booking",
    async (status, persistedStart, expectedError) => {
      const mocked = replayDb({ status, start_time_utc: persistedStart });
      const result = await call(
        mocked.client,
        { ...args, staff_id: "any", confirmed_pricing_fingerprint: FINGERPRINT },
        "yes",
      );

      expect(result).toMatchObject({
        success: false,
        error: expectedError,
        current_status: status,
        current_start_time_utc: persistedStart,
      });
      expect(mocked.rpc).not.toHaveBeenCalled();
      expect(afterJobs).toHaveLength(0);
    },
  );

  it("fails closed when the idempotency row does not match request facts", async () => {
    const mocked = replayDb({ client_phone: "16045550000" });
    const result = await call(
      mocked.client,
      { ...args, staff_id: "any", confirmed_pricing_fingerprint: FINGERPRINT },
      "yes",
    );

    expect(result).toEqual({ success: false, error: "idempotency_conflict" });
    expect(mocked.rpc).not.toHaveBeenCalled();
    expect(afterJobs).toHaveLength(0);
  });
});

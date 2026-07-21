import { describe, it, expect, vi } from "vitest";

// after() only runs in a Next request scope; no-op it (same reason as the gate spec).
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: () => {} };
});

import { executeVoiceTool } from "../toolExecutor";

/**
 * Contract tests for the confirm_booking time-confirmation guard.
 *
 * A real call booked 5:30 PM after the caller said "six" for a 6:00 PM slot.
 * The guard compares the caller's trusted last utterance to the model's chosen
 * time_slot and refuses the booking on a clear mismatch. These tests drive it
 * through the exported executeVoiceTool, exactly as /api/voice/tool does.
 */

const SALON_SLUG = "test-salon";
const OWNER_PHONE = "16045551234";

type Row = Record<string, unknown>;

function mockDb(fixtures: Record<string, Row[] | Row | null>) {
  const make = (table: string) => {
    const rows = fixtures[table];
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    const one = list[0] ?? null;
    const chain: Record<string, unknown> = {
      select: () => chain, insert: () => chain, update: () => chain,
      eq: () => chain, neq: () => chain, gte: () => chain, lte: () => chain,
      in: () => chain, is: () => chain, ilike: () => chain, order: () => chain, limit: () => chain,
      single: async () => ({ data: one, error: null }),
      maybeSingle: async () => ({ data: one, error: null }),
      then: (r: (v: unknown) => unknown) => r({ data: list, error: null }),
    };
    return chain;
  };
  return { from: (t: string) => make(t) } as never;
}

const salonRow = { id: "salon-uuid-1", timezone: "America/Los_Angeles", opening_hours: null, booking_closed_dates: null };

const confirmArgs = (timeSlot: string) => ({
  service_id: "svc-1",
  date: "2026-08-01",
  time_slot: timeSlot,
  staff_id: "any",
  customer_name: "John Tran",
  customer_phone: OWNER_PHONE,
});

async function confirm(
  timeSlot: string,
  opts: { callerVerifiedPhone?: string | null; trustedUserUtterance?: string | null },
) {
  const res = await executeVoiceTool(
    mockDb({ salons: salonRow, phone_otp_sessions: null }),
    SALON_SLUG,
    "confirm_booking",
    confirmArgs(timeSlot),
    null,
    "https://example.test",
    opts,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("confirm_booking — time-confirmation guard", () => {
  it("blocks the real bug: caller said 'six点', model chose 5:30 PM", async () => {
    const { body } = await confirm("5:30 PM", { callerVerifiedPhone: OWNER_PHONE, trustedUserUtterance: "six点" });
    expect(body.error).toBe("time_confirmation_mismatch");
    expect(body.requested_time_slot).toBe("5:30 PM");
    expect(body.success).toBeUndefined();
  });

  it("blocks 'six' against 5:30 PM", async () => {
    const { body } = await confirm("5:30 PM", { callerVerifiedPhone: OWNER_PHONE, trustedUserUtterance: "six" });
    expect(body.error).toBe("time_confirmation_mismatch");
  });

  it("lets '6 giờ' through for a 6:00 PM slot (not blocked by the guard)", async () => {
    const { body } = await confirm("6:00 PM", { callerVerifiedPhone: OWNER_PHONE, trustedUserUtterance: "6 giờ" });
    expect(body.error).not.toBe("time_confirmation_mismatch");
  });

  it("lets a plain 'yes' through — no time spoken, guard defers to the read-back", async () => {
    const { body } = await confirm("6:00 PM", { callerVerifiedPhone: OWNER_PHONE, trustedUserUtterance: "yes" });
    expect(body.error).not.toBe("time_confirmation_mismatch");
  });

  it("a browser call (no trusted utterance) cannot be blocked OR checked by the guard", async () => {
    // The route only sets trustedUserUtterance from the bridge secret. Web omits
    // it, so the guard never runs — a model cannot smuggle a fake utterance via
    // toolArgs to satisfy its own wrong time, because the guard reads only the
    // trusted field, which the model does not control.
    const { body } = await confirm("5:30 PM", { callerVerifiedPhone: OWNER_PHONE /* no trustedUserUtterance */ });
    expect(body.error).not.toBe("time_confirmation_mismatch");
  });

  it("still enforces the OTP / caller-ID gate when the time matches", async () => {
    // Matching time passes the guard, then the identity gate must still fire:
    // no caller-ID, no OTP session → otp_required.
    const { body } = await confirm("6:00 PM", { trustedUserUtterance: "six" });
    expect(body.error).toBe("otp_required");
  });
});

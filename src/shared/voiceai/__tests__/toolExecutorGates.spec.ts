import { describe, it, expect } from "vitest";

import { executeVoiceTool } from "../toolExecutor";

/**
 * Contract tests for the receptionist tool executor's identity gate.
 *
 * These exist because of how the gate is lost, not how it is written. Twice
 * during the split of the AI-receptionist branch, a rebase dropped a shipped
 * security fix — once the OTP gate itself, once #781's whole-party-cancel gate
 * and phone-suffix guard. Both times `tsc` was clean and `next build` was
 * green, because deleting a guard breaks no types. The regressions were caught
 * by grepping, which is not a control.
 *
 * So these tests assert the guarantees a reviewer actually cares about, from
 * the outside, through the exported entry point:
 *
 *   • no mutating tool acts without proof the caller controls the phone
 *   • a caller that omits opts.callerVerifiedPhone gets the STRICT path
 *   • phone-suffix lookups refuse inputs too short to identify one person
 *
 * If a future refactor moves these handlers again, this file fails before the
 * change reaches production.
 */

const SALON_SLUG = "test-salon";
const SALON_ID = "salon-uuid-1";
const BOOKING_ID = "booking-uuid-1";
const GROUP_ID = "group-uuid-1";
const OWNER_PHONE = "16045551234";

type Row = Record<string, unknown>;

/**
 * Chainable Supabase stub. Terminal calls (`single`, `maybeSingle`) resolve the
 * fixture registered for the table named in `.from()`; list queries await to
 * `{ data: rows }`. Deliberately permissive — the point is to get each handler
 * as far as its gate, not to model PostgREST.
 */
function mockDb(fixtures: Record<string, Row[] | Row | null>) {
  const make = (table: string) => {
    const rows = fixtures[table];
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    const one = list[0] ?? null;
    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: () => chain,
      update: () => chain,
      eq: () => chain,
      neq: () => chain,
      gte: () => chain,
      lte: () => chain,
      in: () => chain,
      is: () => chain,
      ilike: () => chain,
      order: () => chain,
      limit: () => chain,
      single: async () => ({ data: one, error: null }),
      maybeSingle: async () => ({ data: one, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: list, error: null }),
    };
    return chain;
  };
  return { from: (table: string) => make(table) } as never;
}

const salonRow = { id: SALON_ID, timezone: "America/Los_Angeles", name: "Test Salon" };

/** Every mutating tool, with the minimum args needed to reach its gate. */
const MUTATING_TOOLS: {
  name: string;
  args: Record<string, unknown>;
  fixtures: Record<string, Row[] | Row | null>;
}[] = [
  {
    name: "confirm_booking",
    args: {
      service_id: "svc-1",
      date: "2026-08-01",
      time_slot: "2:00 PM",
      customer_name: "Test Customer",
      customer_phone: OWNER_PHONE,
      staff_id: "any",
    },
    fixtures: { salons: salonRow, phone_otp_sessions: null },
  },
  {
    name: "cancel_booking",
    args: { booking_id: BOOKING_ID },
    fixtures: {
      salons: salonRow,
      phone_otp_sessions: null,
      bookings: {
        id: BOOKING_ID,
        salon_id: SALON_ID,
        status: "confirmed",
        client_name: "Test Customer",
        client_phone: OWNER_PHONE,
        group_id: null,
        start_time_utc: new Date(Date.now() + 86_400_000).toISOString(),
        services: { name: "Gel Manicure" },
      },
    },
  },
  {
    name: "reschedule_booking",
    args: {
      booking_id: BOOKING_ID,
      new_date: "2026-08-02",
      new_time_slot: "3:00 PM",
      staff_id: "any",
    },
    fixtures: {
      salons: salonRow,
      phone_otp_sessions: null,
      bookings: {
        id: BOOKING_ID,
        salon_id: SALON_ID,
        service_id: "svc-1",
        staff_id: "staff-1",
        status: "confirmed",
        client_name: "Test Customer",
        client_phone: OWNER_PHONE,
        start_time_utc: new Date(Date.now() + 86_400_000).toISOString(),
        end_time_utc: new Date(Date.now() + 90_000_000).toISOString(),
      },
    },
  },
];

async function call(
  toolName: string,
  args: Record<string, unknown>,
  fixtures: Record<string, Row[] | Row | null>,
  opts?: { callerVerifiedPhone?: string | null },
) {
  const res = await executeVoiceTool(
    mockDb(fixtures),
    SALON_SLUG,
    toolName,
    args,
    null,
    "https://example.test",
    opts,
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("toolExecutor — identity gate is enforced inside the executor", () => {
  for (const tool of MUTATING_TOOLS) {
    it(`${tool.name} refuses to act without OTP proof`, async () => {
      const body = await call(tool.name, tool.args, tool.fixtures);
      expect(body.error).toBe("otp_required");
    });

    it(`${tool.name} does not accept a caller-supplied otp_session_id that does not exist`, async () => {
      const body = await call(
        tool.name,
        { ...tool.args, otp_session_id: "made-up-session" },
        tool.fixtures,
      );
      // The session lookup returns null, so the gate must still refuse.
      expect(body.error).toBe("otp_required");
    });
  }

  it("omitting opts entirely yields the STRICT path, never the weaker one", async () => {
    // A surface that forgets to pass callerVerifiedPhone (text chat does) must
    // not thereby skip verification.
    const t = MUTATING_TOOLS[0];
    const body = await call(t.name, t.args, t.fixtures);
    expect(body.error).toBe("otp_required");
  });

  it("a caller-ID for a DIFFERENT phone does not unlock the action", async () => {
    const t = MUTATING_TOOLS[1]; // cancel_booking, owned by OWNER_PHONE
    const body = await call(t.name, t.args, t.fixtures, {
      callerVerifiedPhone: "16045559999",
    });
    expect(body.error).toBe("otp_required");
  });
});

describe("toolExecutor — a whole party is never cancelled without proof", () => {
  const partyFixtures = {
    salons: salonRow,
    phone_otp_sessions: null,
    bookings: [
      { id: "b1", status: "confirmed", client_phone: OWNER_PHONE, is_group_organizer: true, group_id: GROUP_ID },
      { id: "b2", status: "confirmed", client_phone: null, is_group_organizer: false, group_id: GROUP_ID },
    ],
  };

  // The group branch is reachable as of the ordering fix, so these exercise the
  // gate itself rather than an early return further up. Before it, the branch
  // was dead code: the phone lookup returned on all of its paths and sat in
  // front of it, so no argument combination ever arrived here.
  it("cancelling a whole party without proof is refused", async () => {
    const body = await call("cancel_booking", { group_id: GROUP_ID }, partyFixtures);
    expect(body.error).toBe("otp_required");
    expect(body.success).toBeUndefined();
    expect(body.cancelled_count).toBeUndefined();
  });

  it("supplying a phone alongside group_id does not bypass the gate", async () => {
    // The spoken phone is attacker-controlled and is NOT the proof — the gate
    // verifies against the organizer's number as stored on the party rows.
    const body = await call(
      "cancel_booking",
      { group_id: GROUP_ID, customer_phone: "16045559999" },
      partyFixtures,
    );
    expect(body.error).toBe("otp_required");
    expect(body.cancelled_count).toBeUndefined();
  });

  it("a party with no phone anywhere is refused rather than cancelled unverified", async () => {
    const body = await call("cancel_booking", { group_id: GROUP_ID }, {
      ...partyFixtures,
      bookings: [
        { id: "b1", status: "confirmed", client_phone: null, is_group_organizer: true, group_id: GROUP_ID },
        { id: "b2", status: "confirmed", client_phone: "", is_group_organizer: false, group_id: GROUP_ID },
      ],
    });
    expect(body.error).toBe("group_not_verifiable");
    expect(body.cancelled_count).toBeUndefined();
  });

  it("a party already fully cancelled is a 404, not a no-op success", async () => {
    const body = await call("cancel_booking", { group_id: GROUP_ID }, {
      ...partyFixtures,
      bookings: [
        { id: "b1", status: "cancelled", client_phone: OWNER_PHONE, is_group_organizer: true, group_id: GROUP_ID },
      ],
    });
    expect(body.error).toBe("group_not_found_or_already_cancelled");
  });
});

describe("toolExecutor — a verified caller CAN cancel the party", () => {
  // The point of the ordering fix. Without this the branch could be reachable
  // and still broken, and the gate tests above would happily pass.
  const verifiedSession = {
    phone: OWNER_PHONE,
    consumed_at: null,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  };

  it("a valid OTP session for the organizer cancels every active row", async () => {
    const body = await call("cancel_booking", { group_id: GROUP_ID, otp_session_id: "sess-1" }, {
      salons: salonRow,
      phone_otp_sessions: verifiedSession,
      bookings: [
        { id: "b1", status: "confirmed", client_phone: OWNER_PHONE, is_group_organizer: true, group_id: GROUP_ID },
        { id: "b2", status: "confirmed", client_phone: null, is_group_organizer: false, group_id: GROUP_ID },
      ],
    });
    expect(body.success).toBe(true);
    expect(body.cancelled_count).toBe(2);
  });

  it("carrier-verified caller-ID for the organizer also works, without a code", async () => {
    const body = await call("cancel_booking", { group_id: GROUP_ID }, {
      salons: salonRow,
      phone_otp_sessions: null,
      bookings: [
        { id: "b1", status: "confirmed", client_phone: OWNER_PHONE, is_group_organizer: true, group_id: GROUP_ID },
      ],
    }, { callerVerifiedPhone: OWNER_PHONE });
    expect(body.success).toBe(true);
    expect(body.cancelled_count).toBe(1);
  });

  it("already-cancelled rows are not re-cancelled or counted", async () => {
    const body = await call("cancel_booking", { group_id: GROUP_ID }, {
      salons: salonRow,
      phone_otp_sessions: null,
      bookings: [
        { id: "b1", status: "confirmed", client_phone: OWNER_PHONE, is_group_organizer: true, group_id: GROUP_ID },
        { id: "b2", status: "cancelled",  client_phone: null, is_group_organizer: false, group_id: GROUP_ID },
      ],
    }, { callerVerifiedPhone: OWNER_PHONE });
    expect(body.success).toBe(true);
    expect(body.cancelled_count).toBe(1);
  });
});

describe("toolExecutor — cancel_booking routes on the right identifier", () => {
  it("no identifier at all is rejected", async () => {
    const body = await call("cancel_booking", {}, { salons: salonRow });
    expect(body.error).toBe("missing_booking_id_or_phone");
  });

  it("group_id alone is a valid identifier (it used to bounce as 'missing')", async () => {
    const body = await call("cancel_booking", { group_id: GROUP_ID }, {
      salons: salonRow,
      phone_otp_sessions: null,
      bookings: [
        { id: "b1", status: "confirmed", client_phone: OWNER_PHONE, is_group_organizer: true, group_id: GROUP_ID },
      ],
    });
    // Reaches the gate instead of bouncing off the argument check.
    expect(body.error).not.toBe("missing_booking_id_or_phone");
    expect(body.error).toBe("otp_required");
  });
});

describe("toolExecutor — phone suffix lookups need enough digits (#781)", () => {
  // `ilike '%' || suffix` on a surface reachable without auth: one digit used to
  // match every booking whose number ends in it.
  for (const toolName of ["find_booking", "cancel_booking"]) {
    it(`${toolName} refuses a 1-digit phone`, async () => {
      const body = await call(toolName, { customer_phone: "5" }, { salons: salonRow });
      expect(body.error).toBe("phone_too_short");
    });

    it(`${toolName} refuses a 6-digit phone (below the 7-digit floor)`, async () => {
      const body = await call(toolName, { customer_phone: "123456" }, { salons: salonRow });
      expect(body.error).toBe("phone_too_short");
    });
  }
});

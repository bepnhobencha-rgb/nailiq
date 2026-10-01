import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), log: vi.fn(), audit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock("@/shared/lib/twilioSignature", () => ({
  getTwilioAuthToken: async () => "synthetic-token",
  validateTwilioSignature: () => true,
  twilioRequestBaseUrl: () => "https://nailiq.test",
}));
vi.mock("@/shared/lib/notificationLog", () => ({ logNotification: mocks.log }));
vi.mock("@/shared/dashboard/auditLog", () => ({ logBookingEvent: mocks.audit }));

import { POST } from "./route";

const bookingId = "30260930-0000-4000-8000-000000000021";
const salonId = "30260930-0000-4000-8000-000000000022";
const booking = {
  id: bookingId, salon_id: salonId, service_id: "synthetic-service",
  start_time_utc: "2099-01-01T20:00:00.000Z", status: "pending",
  reminder_24h_sent_at: null, reminder_3h_sent_at: null,
  sms_confirmation_sent_at: null,
};

function chain(result: { data: unknown; error: unknown }) {
  const query = {
    select: vi.fn(), eq: vi.fn(), in: vi.fn(), gte: vi.fn(), order: vi.fn(),
    update: vi.fn(), limit: vi.fn().mockResolvedValue(result),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
  for (const name of ["select", "eq", "in", "gte", "order", "update"] as const) {
    query[name].mockReturnValue(query);
  }
  return query;
}

let list: ReturnType<typeof chain>;
let write: ReturnType<typeof chain>;
let readBack: ReturnType<typeof chain>;

function request(body: string) {
  return new NextRequest("https://nailiq.test/api/twilio/inbound", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Body: body, From: "+16045550123", To: "+16045550456" }),
  });
}

describe("inbound booking replies require committed truth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list = chain({ data: [booking], error: null });
    write = chain({ data: { id: bookingId }, error: null });
    readBack = chain({ data: { id: bookingId, status: "confirmed" }, error: null });
    const salon = chain({ data: { name: "Synthetic Salon" }, error: null });
    let reads = 0;
    mocks.from.mockImplementation((table: string) => {
      if (table === "salons") return salon;
      if (table !== "bookings") throw new Error("unexpected_table");
      return [list, write, readBack][reads++];
    });
    mocks.rpc.mockResolvedValue({
      data: { ok: true, code: "ok", booking_id: bookingId }, error: null,
    });
    mocks.log.mockResolvedValue(undefined);
    mocks.audit.mockResolvedValue(undefined);
  });

  it("does not turn a booking lookup error into a customer-not-found reply", async () => {
    list.limit.mockResolvedValue({ data: null, error: { code: "synthetic_db_error" } });
    const response = await POST(request("YES"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("upcoming appointment");
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("acknowledges a successful conditional confirmation", async () => {
    const response = await POST(request("YES"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Confirmed!");
    expect(write.eq).toHaveBeenCalledWith("status", "pending");
    expect(write.eq).toHaveBeenCalledWith("salon_id", salonId);
    expect(write.select).toHaveBeenCalledWith("id");
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("never confirms an errored write", async () => {
    write.maybeSingle.mockResolvedValue({ data: null, error: { code: "synthetic_write_error" } });
    const response = await POST(request("YES"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("Confirmed!");
    expect(mocks.log).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it.each(["cancelled", "completed", "no_show", "pending"])(
    "never confirms a zero-row update whose current state is %s", async (status) => {
      write.maybeSingle.mockResolvedValue({ data: null, error: null });
      readBack.maybeSingle.mockResolvedValue({ data: { id: bookingId, status }, error: null });
      const response = await POST(request("YES"));
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("Confirmed!");
      expect(mocks.log).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    },
  );

  it("accepts a confirmation replay only after same-booking confirmed read-back", async () => {
    write.maybeSingle.mockResolvedValue({ data: null, error: null });
    const response = await POST(request("YES"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Confirmed!");
    expect(readBack.eq).toHaveBeenCalledWith("id", bookingId);
    expect(readBack.eq).toHaveBeenCalledWith("salon_id", salonId);
  });

  it("fails closed when confirmation read-back is unavailable", async () => {
    write.maybeSingle.mockResolvedValue({ data: null, error: null });
    readBack.maybeSingle.mockResolvedValue({ data: null, error: { code: "synthetic_read_error" } });
    expect((await POST(request("YES"))).status).toBe(503);
    expect(mocks.log).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it.each([
    { data: null, error: { code: "synthetic_rpc_error" } },
    { data: { ok: false, code: "conflict" }, error: null },
    { data: { ok: true, code: "ok", booking_id: salonId }, error: null },
  ])("never tells the customer cancellation succeeded without exact RPC truth: %j", async (result) => {
    mocks.rpc.mockResolvedValue(result);
    const response = await POST(request("NO"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("is cancelled");
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("retains the committed cancellation reply", async () => {
    const response = await POST(request("NO"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("is cancelled");
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });
});

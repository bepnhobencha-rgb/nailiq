import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  verifyIndividualWaitlistAvailability: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/booking/verifyIndividualWaitlistAvailability", () => ({
  verifyIndividualWaitlistAvailability:
    mocks.verifyIndividualWaitlistAvailability,
}));
vi.mock("@/shared/lib/inAppRateLimit", () => ({ clientIp: () => "test-ip" }));

import { POST } from "@/app/api/booking/capacity-rescue/route";

const IDS = {
  salon: "00000000-0000-4000-8000-000000000001",
  request: "00000000-0000-4000-8000-000000000002",
  service: "00000000-0000-4000-8000-000000000003",
  entry: "00000000-0000-4000-8000-000000000004",
};
const body = {
  salonId: IDS.salon,
  requestId: IDS.request,
  requestKind: "individual",
  primaryServiceId: IDS.service,
  staffId: null,
  bookingDateYmd: "2030-09-05",
  preferredSlotLabel: "2:00 PM",
  partySize: 1,
  clientName: "Jane Customer",
  clientPhone: "7788680738",
  clientEmail: "jane@example.com",
  clientLocale: "en",
  intent: {
    serviceIds: [IDS.service],
    staffPreference: "any",
    source: "slot_unavailable",
  },
};

function request(payload: object = body) {
  return new NextRequest("http://localhost/api/booking/capacity-rescue", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

function chainResult(data: unknown, error: unknown = null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue({ data, error });
  return chain;
}

function database(existing: unknown = null) {
  const rpc = vi.fn(async (name: string) =>
    name === "rate_limit_hit"
      ? { data: true, error: null }
      : {
          data: [{ id: IDS.entry, status: "waiting", created_new: true }],
          error: null,
        },
  );
  return {
    rpc,
    from: vi.fn((table: string) =>
      table === "salons"
        ? chainResult({ id: IDS.salon, slug: "hilite-anaheim" })
        : chainResult(existing),
    ),
  };
}

describe("POST /api/booking/capacity-rescue", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not insert when the preferred slot is still available", async () => {
    const db = database();
    mocks.createServiceRoleClient.mockReturnValue(db);
    mocks.verifyIndividualWaitlistAvailability.mockResolvedValue({
      outcome: "slot_available",
      slotLabel: "2:00 PM",
    });
    const result = await POST(request());
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({
      ok: false,
      code: "slot_available",
      slotLabel: "2:00 PM",
    });
    expect(db.rpc).not.toHaveBeenCalledWith(
      "create_public_capacity_rescue_request",
      expect.anything(),
    );
  });

  it("fails closed without inserting when availability cannot be verified", async () => {
    const db = database();
    mocks.createServiceRoleClient.mockReturnValue(db);
    mocks.verifyIndividualWaitlistAvailability.mockResolvedValue({
      outcome: "availability_unverified",
    });
    const result = await POST(request());
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({
      ok: false,
      code: "availability_unverified",
    });
    expect(db.rpc).not.toHaveBeenCalledWith(
      "create_public_capacity_rescue_request",
      expect.anything(),
    );
  });

  it("inserts once after the exact preferred slot is verified unavailable", async () => {
    const db = database();
    mocks.createServiceRoleClient.mockReturnValue(db);
    mocks.verifyIndividualWaitlistAvailability.mockResolvedValue({
      outcome: "slot_unavailable",
    });
    const result = await POST(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      ok: true,
      outcome: "slot_unavailable",
      receipt: { requestId: IDS.entry, createdNew: true },
    });
    expect(db.rpc).toHaveBeenCalledWith(
      "create_public_capacity_rescue_request",
      expect.anything(),
    );
  });

  it("returns the prior receipt on an exact request retry before revalidating", async () => {
    const db = database({
      id: IDS.entry,
      status: "waiting",
      request_kind: "individual",
      booking_date: body.bookingDateYmd,
      preferred_slot_label: body.preferredSlotLabel,
      party_size: 1,
      client_name: body.clientName,
      client_phone: "17788680738",
      client_email: body.clientEmail,
      client_locale: body.clientLocale,
      intent_json: body.intent,
    });
    mocks.createServiceRoleClient.mockReturnValue(db);
    const result = await POST(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      receipt: { requestId: IDS.entry, createdNew: false },
    });
    expect(mocks.verifyIndividualWaitlistAvailability).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalledWith(
      "create_public_capacity_rescue_request",
      expect.anything(),
    );
  });

  it("rejects a changed payload that reuses a request ID", async () => {
    const db = database({
      id: IDS.entry,
      status: "waiting",
      request_kind: "individual",
      booking_date: body.bookingDateYmd,
      preferred_slot_label: body.preferredSlotLabel,
      party_size: 1,
      client_name: body.clientName,
      client_phone: "17788680738",
      client_email: body.clientEmail,
      client_locale: body.clientLocale,
      intent_json: body.intent,
    });
    mocks.createServiceRoleClient.mockReturnValue(db);
    const result = await POST(request({ ...body, clientName: "Different Name" }));
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: "request_id_conflict" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  createServer: vi.fn(),
  createService: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({
  consumePublicRequestRateLimit: mocks.rate,
}));
vi.mock("@/shared/lib/supabase/server", () => ({ createClient: mocks.createServer }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createService,
}));
vi.mock("@/shared/photos/photoCustomerToken", () => ({
  verifyPhotoCustomerToken: mocks.verifyToken,
}));

import { GET, PATCH } from "./route";

const phone = "16045550199";
const salonId = "22222222-2222-4222-8222-222222222222";
const photoId = "11111111-1111-4111-8111-111111111111";

function chain(result: unknown) {
  const value: Record<string, unknown> = {};
  for (const name of ["select", "eq", "is", "in", "update", "maybeSingle", "single"]) {
    value[name] = vi.fn(() => value);
  }
  value.then = (resolve: (input: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return value;
}

function request(input?: { bearer?: string; salon?: string }) {
  return new Request(`https://nailiq.test/api/customer/${phone}/consents`, {
    method: "PATCH",
    headers: {
      origin: "https://nailiq.test",
      host: "nailiq.test",
      "content-type": "application/json",
      ...(input?.bearer ? { authorization: `Bearer ${input.bearer}` } : {}),
    },
    body: JSON.stringify({ salon_id: input?.salon ?? salonId }),
  });
}

function memberClient(memberships: { salon_id: string }[]) {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "member" } }, error: null }) },
    from: vi.fn(() => chain({ data: memberships, error: null })),
  };
}

function anonymousClient() {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) },
  };
}

function serviceClient(binding: { data: unknown; error: unknown } = {
  data: {
    id: photoId,
    salon_id: salonId,
    bookings: { client_phone: phone, salon_id: salonId },
  },
  error: null,
}) {
  return {
    from: vi.fn((table: string) => {
      if (table === "booking_photos") {
        return chain(binding);
      }
      if (table === "bookings") return chain({ data: [], error: null });
      return chain({ data: null, error: null });
    }),
  };
}

describe("customer consent authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rate.mockResolvedValue("allowed");
    mocks.createService.mockImplementation(serviceClient);
  });

  it("allows a same-salon first-party member", async () => {
    mocks.createServer.mockResolvedValue(memberClient([{ salon_id: salonId }]));
    const response = await PATCH(request(), { params: Promise.resolve({ phone }) });
    expect(response.status).toBe(200);
    expect(mocks.verifyToken).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   ", salonId, `  ${salonId}  `])("preserves optional, empty and trimmed salon scope validation (%s)", async (salon) => {
    mocks.createServer.mockResolvedValue(memberClient([{ salon_id: salonId }]));
    const req = new Request(`https://nailiq.test/api/customer/${phone}/consents`, {
      method: "PATCH", headers: { origin: "https://nailiq.test", "content-type": "application/json" },
      body: JSON.stringify({ salon_id: salon }),
    });
    const response = await PATCH(req, { params: Promise.resolve({ phone }) });
    expect(response.status).toBe(200);
    expect(mocks.createService).toHaveBeenCalledTimes(1);
  });

  it.each(["GET", "PATCH"] as const)("rejects a session whose verified Auth user is absent on %s", async method => {
    mocks.createServer.mockResolvedValue(anonymousClient()); mocks.verifyToken.mockResolvedValue(null);
    const response = method === "GET"
      ? await GET(new Request(`https://nailiq.test/api/customer/${phone}/consents?salon_id=${salonId}`), { params: Promise.resolve({ phone }) })
      : await PATCH(request(), { params: Promise.resolve({ phone }) });
    expect(response.status).toBe(401); expect(mocks.createService).not.toHaveBeenCalled();
  });

  it.each([null, [], { revoked_reason: 9 }, { salon_id: [] }, { salon_id: "not-a-uuid" }, { revoked_reason: "x".repeat(501) }])("rejects malformed PATCH body before auth/DB", async body => {
    const req = new Request(`https://nailiq.test/api/customer/${phone}/consents`, {
      method: "PATCH", headers: { origin: "https://nailiq.test", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const response = await PATCH(req, { params: Promise.resolve({ phone }) });
    expect(response.status).toBe(400);
    expect(mocks.createService).not.toHaveBeenCalled();
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it.each(["{bad-json", JSON.stringify({ padding: "x".repeat(4096) })])("rejects malformed or oversized streamed bytes with misleading Content-Length", async body => {
    const req = new Request(`https://nailiq.test/api/customer/${phone}/consents`, {
      method: "PATCH", headers: { origin: "https://nailiq.test", "content-type": "application/json", "content-length": "2" }, body,
    });
    const response = await PATCH(req, { params: Promise.resolve({ phone }) });
    expect(response.status).toBe(400); expect(mocks.createServer).not.toHaveBeenCalled(); expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("allows a purpose-bound customer bearer after authoritative photo binding", async () => {
    mocks.createServer.mockResolvedValue(anonymousClient());
    mocks.verifyToken.mockResolvedValue({ photoId, salonId, phone });
    const response = await PATCH(request({ bearer: "valid" }), {
      params: Promise.resolve({ phone }),
    });
    expect(response.status).toBe(200);
    expect(mocks.createService).toHaveBeenCalledTimes(1);
  });

  it.each([
    [null, salonId, phone, 401],
    [{ photoId, salonId, phone: "16045550000" }, salonId, phone, 403],
    [{ photoId, salonId, phone }, "33333333-3333-4333-8333-333333333333", phone, 403],
  ] as const)("rejects malformed/cross-boundary bearer before service role", async (claims, requestedSalon, routePhone, status) => {
    mocks.createServer.mockResolvedValue(anonymousClient());
    mocks.verifyToken.mockResolvedValue(claims);
    const response = await PATCH(request({ bearer: "token", salon: requestedSalon }), {
      params: Promise.resolve({ phone: routePhone }),
    });
    expect(response.status).toBe(status);
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("rejects a member attempting another salon before service role", async () => {
    mocks.createServer.mockResolvedValue(memberClient([{ salon_id: salonId }]));
    const response = await PATCH(
      request({ salon: "33333333-3333-4333-8333-333333333333" }),
      { params: Promise.resolve({ phone }) },
    );
    expect(response.status).toBe(403);
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it.each([
    ["not found or deleted", { data: null, error: null }],
    ["query error", { data: null, error: { message: "down" } }],
    ["photo salon mismatch", {
      data: {
        id: photoId,
        salon_id: "33333333-3333-4333-8333-333333333333",
        bookings: { client_phone: phone, salon_id: salonId },
      },
      error: null,
    }],
    ["booking salon mismatch", {
      data: {
        id: photoId,
        salon_id: salonId,
        bookings: {
          client_phone: phone,
          salon_id: "33333333-3333-4333-8333-333333333333",
        },
      },
      error: null,
    }],
    ["booking phone mismatch", {
      data: {
        id: photoId,
        salon_id: salonId,
        bookings: { client_phone: "16045550000", salon_id: salonId },
      },
      error: null,
    }],
  ] as const)("rejects authoritative %s before consent/photo mutation", async (_label, binding) => {
    mocks.createServer.mockResolvedValue(anonymousClient());
    mocks.verifyToken.mockResolvedValue({ photoId, salonId, phone });
    const service = serviceClient(binding);
    mocks.createService.mockReturnValue(service);

    const response = await PATCH(request({ bearer: "valid" }), {
      params: Promise.resolve({ phone }),
    });
    expect(response.status).toBe(403);
    expect(service.from).toHaveBeenCalledTimes(1);
    expect(service.from).toHaveBeenCalledWith("booking_photos");
  });
});

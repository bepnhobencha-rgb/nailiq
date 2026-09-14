import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServer: vi.fn(),
  createService: vi.fn(),
  rate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/server", () => ({ createClient: mocks.createServer }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createService,
}));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({
  consumePublicRequestRateLimit: mocks.rate,
}));

import { POST } from "./route";

const bookingId = "11111111-1111-4111-8111-111111111111";
const salonId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const phone = "16045550199";

function chain(result: unknown) {
  const value: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of ["select", "eq", "is", "maybeSingle", "single", "insert", "upsert"]) {
    value[name] = vi.fn(() => value);
  }
  Object.assign(value, {
    then: (resolve: (input: unknown) => unknown) => Promise.resolve(result).then(resolve),
  });
  return value;
}

function serviceClient(input?: {
  booking?: Record<string, unknown> | null;
  membership?: Record<string, unknown> | null;
  actorStaff?: Record<string, unknown> | null;
  actorStaffError?: unknown;
  consentError?: unknown;
}) {
  const bookingQuery = chain({
    data: input?.booking === null ? null : input?.booking ?? {
      id: bookingId,
      salon_id: salonId,
      status: "completed",
      staff_id: null,
      client_phone: phone,
    },
    error: null,
  });
  const membershipQuery = chain({
    data: input?.membership === null ? null : input?.membership ?? { id: "member-id", role: "nail_tech" },
    error: null,
  });
  const consentQuery = chain({ data: null, error: input?.consentError ?? null });
  const actorStaffQuery = chain({
    data: input?.actorStaff === null ? null : input?.actorStaff ?? { id: "staff-id" },
    error: input?.actorStaffError ?? null,
  });
  const photoQuery = chain({
    data: { id: "44444444-4444-4444-8444-444444444444", storage_path: "photo.jpg" },
    error: null,
  });
  const upload = vi.fn().mockResolvedValue({ error: null });
  const remove = vi.fn().mockResolvedValue({ error: null });
  const service = {
    from: vi.fn((table: string) => {
      if (table === "bookings") return bookingQuery;
      if (table === "salon_members") return membershipQuery;
      if (table === "staff") return actorStaffQuery;
      if (table === "customer_photo_consents") return consentQuery;
      return photoQuery;
    }),
    storage: { from: vi.fn(() => ({ upload, remove })) },
    upload,
    consentUpsert: consentQuery.upsert,
  };
  return service;
}

function request(input?: { consents?: unknown; includePhoneConsent?: boolean }) {
  const form = new FormData();
  form.set("booking_id", bookingId);
  form.set("photo", new File([new Uint8Array([1, 2, 3])], "nails.jpg", { type: "image/jpeg" }));
  form.set("consents", JSON.stringify(input?.consents ?? {
    consent_receive_sms: input?.includePhoneConsent ?? true,
    consent_save_to_profile: true,
    consent_share_public: false,
    consent_use_marketing: false,
  }));
  return new Request("https://nailiq.test/api/staff/photo-upload", {
    method: "POST",
    headers: { origin: "https://nailiq.test", host: "nailiq.test" },
    body: form,
  });
}

describe("staff photo upload consent and abuse boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    mocks.createServer.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: userId } } }) },
    });
    mocks.rate.mockResolvedValue("allowed");
    mocks.createService.mockImplementation(() => serviceClient());
  });

  it("records a schema-valid in-salon consent before uploading", async () => {
    const service = serviceClient();
    mocks.createService.mockReturnValue(service);
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(service.consentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        salon_id: salonId,
        client_phone: phone,
        granted_via: "in_salon",
        granted_by_staff_id: "staff-id",
        revoked_at: null,
        revoked_reason: null,
      }),
      { onConflict: "salon_id,client_phone", ignoreDuplicates: false },
    );
    expect(service.upload).toHaveBeenCalledTimes(1);
  });

  it("uses a nullable staff FK when the salon member has no staff profile", async () => {
    const service = serviceClient({ actorStaff: null });
    mocks.createService.mockReturnValue(service);
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(service.consentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ granted_by_staff_id: null }),
      expect.anything(),
    );
  });

  it("fails closed when staff identity lookup is unavailable", async () => {
    const service = serviceClient({ actorStaffError: { message: "down" } });
    mocks.createService.mockReturnValue(service);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.rate).toHaveBeenCalledTimes(1);
    expect(service.upload).not.toHaveBeenCalled();
  });

  it("rejects malformed consent types before service-role access", async () => {
    const response = await POST(request({ consents: { consent_share_public: "yes" } }));
    expect(response.status).toBe(400);
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it.each([
    ["limited", 429],
    ["unavailable", 503],
  ] as const)("fails closed when the durable limiter is %s", async (rate, status) => {
    const service = serviceClient();
    mocks.createService.mockReturnValue(service);
    mocks.rate.mockResolvedValue(rate);
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(service.consentUpsert).not.toHaveBeenCalled();
    expect(service.upload).not.toHaveBeenCalled();
  });

  it("does not upload when durable consent storage fails", async () => {
    const service = serviceClient({ consentError: { message: "constraint" } });
    mocks.createService.mockReturnValue(service);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(service.upload).not.toHaveBeenCalled();
  });

  it("rejects public or messaging consent without an authoritative phone", async () => {
    const service = serviceClient({
      booking: {
        id: bookingId,
        salon_id: salonId,
        status: "completed",
        staff_id: null,
        client_phone: null,
      },
    });
    mocks.createService.mockReturnValue(service);
    const response = await POST(request({ includePhoneConsent: true }));
    expect(response.status).toBe(422);
    expect(service.upload).not.toHaveBeenCalled();
  });
});

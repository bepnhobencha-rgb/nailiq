import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  createService: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({
  consumePublicRequestRateLimit: mocks.rate,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createService,
}));

import { GET } from "./route";

const photoId = "11111111-1111-4111-8111-111111111111";
const salonId = "22222222-2222-4222-8222-222222222222";
const phone = "16045550199";

function chain(result: unknown) {
  const value: Record<string, unknown> = {};
  for (const name of ["select", "in", "eq", "is"]) {
    value[name] = vi.fn(() => value);
  }
  value.then = (resolve: (input: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return value;
}

function serviceClient(input?: {
  photos?: unknown;
  photosError?: unknown;
  consents?: unknown;
  consentsError?: unknown;
  trends?: unknown;
  trendsError?: unknown;
  signedUrl?: string | null;
  signedError?: unknown;
  signedThrows?: boolean;
}) {
  const photoQuery = chain({
    data: input?.photos ?? [{
      id: photoId,
      storage_path: `${salonId}/photo.jpg`,
      salon_id: salonId,
      bookings: { client_phone: phone, salon_id: salonId },
    }],
    error: input?.photosError ?? null,
  });
  const consentQuery = chain({
    data: input?.consents ?? [{ salon_id: salonId, client_phone: phone }],
    error: input?.consentsError ?? null,
  });
  const trendQuery = chain({
    data: input?.trends ?? [{ salon_id: salonId, trends: [{ photo_id: photoId }] }],
    error: input?.trendsError ?? null,
  });
  const createSignedUrl = input?.signedThrows
    ? vi.fn().mockRejectedValue(new Error("storage timeout"))
    : vi.fn().mockResolvedValue({
        data: input?.signedUrl === null ? null : { signedUrl: input?.signedUrl ?? "https://storage.test/signed" },
        error: input?.signedError ?? null,
      });
  return {
    from: vi.fn((table: string) => {
      if (table === "booking_photos") return photoQuery;
      if (table === "ai_trend_cache") return trendQuery;
      return consentQuery;
    }),
    storage: { from: vi.fn(() => ({ createSignedUrl })) },
    createSignedUrl,
  };
}

function request(ids = photoId) {
  return new Request(`https://nailiq.test/api/photos/signed-urls?ids=${encodeURIComponent(ids)}`, {
    headers: { "x-forwarded-for": "198.51.100.20" },
  });
}

describe("public photo signed URLs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rate.mockResolvedValue("allowed");
    mocks.createService.mockImplementation(() => serviceClient());
  });

  it.each([
    ["bad", 400],
    [Array.from({ length: 21 }, (_, index) => `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`).join(","), 400],
  ])("rejects invalid or oversized photo ID sets before rate limit and service role", async (ids, status) => {
    const response = await GET(request(ids));
    expect(response.status).toBe(status);
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it.each([
    ["limited", 429, "rate_limited"],
    ["unavailable", 503, "temporarily_unavailable"],
  ] as const)("fails closed when the durable limiter is %s", async (rate, status, error) => {
    mocks.rate.mockResolvedValue(rate);
    const response = await GET(request());
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("mints a URL only after the photo, booking and current public consent match", async () => {
    const service = serviceClient({});
    mocks.createService.mockReturnValue(service);
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ [photoId]: "https://storage.test/signed" });
    expect(service.createSignedUrl).toHaveBeenCalledWith(`${salonId}/photo.jpg`, 300);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it.each([
    ["no current consent", { consents: [] }],
    ["photo is not in the public trend cache", { trends: [{ salon_id: salonId, trends: [] }] }],
    ["booking salon mismatch", { photos: [{ id: photoId, storage_path: "photo.jpg", salon_id: salonId, bookings: { client_phone: phone, salon_id: "33333333-3333-4333-8333-333333333333" } }] }],
    ["consent belongs to another customer", { consents: [{ salon_id: salonId, client_phone: "16045550000" }] }],
  ])("does not disclose a URL for %s", async (_label, input) => {
    const service = serviceClient(input);
    mocks.createService.mockReturnValue(service);
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
    expect(service.createSignedUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["photo lookup", { photosError: { message: "down" } }],
    ["consent lookup", { consentsError: { message: "down" } }],
    ["trend lookup", { trendsError: { message: "down" } }],
  ])("fails closed when %s is unavailable", async (_label, input) => {
    const service = serviceClient(input);
    mocks.createService.mockReturnValue(service);
    const response = await GET(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(service.createSignedUrl).not.toHaveBeenCalled();
  });

  it("omits a URL when storage signing fails", async () => {
    const service = serviceClient({ signedError: { message: "down" }, signedUrl: null });
    mocks.createService.mockReturnValue(service);
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
  });

  it("does not surface provider details when storage signing throws", async () => {
    const service = serviceClient({ signedThrows: true });
    mocks.createService.mockReturnValue(service);
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
  });
});

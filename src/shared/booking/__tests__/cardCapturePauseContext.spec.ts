import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), rate: vi.fn(), db: vi.fn(), decision: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/booking/bookingManagementCapabilities", () => ({ inspectBookingManagementCapability: mocks.inspect }));
vi.mock("@/shared/booking/bookingManagementRateLimit", () => ({ consumeBookingManagementRateLimit: mocks.rate }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.db }));
vi.mock("@/shared/integrations/square/noshow", () => ({ noShowCardDecision: mocks.decision }));

import { GET } from "@/app/api/booking/save-card-context/route";

const bookingId = "55650000-0000-4000-8000-000000000001";
const salonId = "55650000-0000-4000-8000-000000000002";
const request = () => new Request(`https://qa.example.test/api/booking/save-card-context?token=${bookingId}`);
let booking: { status: string; noshow_card_id: string | null; noshow_card_required: boolean };
const eq = vi.fn<(table: string, ...args: unknown[]) => void>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NAILIQ_CARD_SAVE_DISPATCH_DISABLED", "true");
  booking = { status: "confirmed", noshow_card_id: null, noshow_card_required: true };
  mocks.rate.mockResolvedValue("allowed");
  mocks.inspect.mockResolvedValue({ ok: true, inspection: { context: { bookingId, salonId } } });
  eq.mockReset();
  mocks.db.mockReturnValue({ from: (table: string) => {
    const builder = {
      select: () => builder,
      eq: (...args: unknown[]) => { eq(table, ...args); return builder; },
      maybeSingle: async () => ({ data: table === "bookings" ? booking : { name: "Synthetic QA", currency_code: "CAD" }, error: null }),
    };
    return builder;
  } });
  mocks.decision.mockRejectedValue(new Error("provider_configuration_unavailable"));
});
afterEach(() => vi.unstubAllEnvs());

describe("paused card-management context", () => {
  it.each([true, false])("preserves stored requirement %s without resolving provider configuration", async required => {
    booking.noshow_card_required = required;
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ ok: true, capturePaused: true, cardRequired: required, alreadySaved: false });
    expect(mocks.decision).not.toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith("bookings", "id", bookingId);
    expect(eq).toHaveBeenCalledWith("bookings", "salon_id", salonId);
  });

  it("keeps existing card and cancellation facts separate from a pause", async () => {
    booking.noshow_card_id = "synthetic-existing-card";
    booking.status = "cancelled";
    expect(await (await GET(request())).json()).toMatchObject({ capturePaused: true, alreadySaved: true, cancelled: true });
    expect(mocks.decision).not.toHaveBeenCalled();
  });

  it("preserves the existing decision path when capture is active", async () => {
    vi.stubEnv("NAILIQ_CARD_SAVE_DISPATCH_DISABLED", "false");
    mocks.decision.mockResolvedValue({ required: true });
    expect(await (await GET(request())).json()).toMatchObject({ capturePaused: false, cardRequired: true });
    expect(mocks.decision).toHaveBeenCalledExactlyOnceWith(bookingId);
  });

  it("does not expose booking metadata to a wrong or expired capability", async () => {
    mocks.inspect.mockResolvedValue({ ok: false, code: "invalid_token" });
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, code: "invalid_token" });
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.decision).not.toHaveBeenCalled();
  });

  it("keeps the inspection rate limit during a capture pause", async () => {
    mocks.rate.mockResolvedValue("limited");
    expect((await GET(request())).status).toBe(429);
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.db).not.toHaveBeenCalled();
  });
});

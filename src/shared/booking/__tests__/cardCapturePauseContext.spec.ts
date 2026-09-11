import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), rate: vi.fn(), db: vi.fn(), consent: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/booking/bookingCardRecovery", () => ({ inspectCardRecovery: mocks.inspect, loadCardRecoveryConsent: mocks.consent }));
vi.mock("@/shared/booking/bookingManagementRateLimit", () => ({ consumeBookingManagementRateLimit: mocks.rate }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.db }));

import { GET } from "@/app/api/booking/save-card-context/route";

const bookingId = "55650000-0000-4000-8000-000000000001";
const salonId = "55650000-0000-4000-8000-000000000002";
const request = () => new Request(`https://qa.example.test/api/booking/save-card-context?token=${bookingId}`);
let booking: { status: string; start_time_utc: string; services: { name: string } };
let recovery: { bookingId: string; salonId: string; protectionStatus: string; canRetry: boolean; canRefreshConsent: boolean; canVerifyExistingCard: boolean; expiresAt: string };
const eq = vi.fn<(table: string, ...args: unknown[]) => void>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NAILIQ_CARD_SAVE_DISPATCH_DISABLED", "true");
  booking = { status: "confirmed", start_time_utc: "2026-09-20T11:00:00Z", services: { name: "Synthetic Service" } };
  recovery = { bookingId, salonId, protectionStatus: "awaiting_card", canRetry: true, canRefreshConsent: false, canVerifyExistingCard: false, expiresAt: "2026-09-20T12:00:00Z" };
  mocks.rate.mockResolvedValue("allowed");
  mocks.inspect.mockImplementation(async () => ({ ok: true, context: recovery }));
  eq.mockReset();
  mocks.db.mockReturnValue({ from: (table: string) => {
    const builder = {
      select: () => builder,
      eq: (...args: unknown[]) => { eq(table, ...args); return builder; },
      maybeSingle: async () => ({ data: table === "bookings" ? booking : { name: "Synthetic QA", currency_code: "CAD" }, error: null }),
    };
    return builder;
  } });
  mocks.consent.mockResolvedValue({ version: "synthetic-policy-v2", policyEn: "Synthetic policy", policyVi: "Chính sách thử nghiệm" });
});
afterEach(() => vi.unstubAllEnvs());

describe("paused card-management context", () => {
  it.each(["not_required", "awaiting_card", "saving", "saved", "reconciliation_pending", "retry_required", "manual_review"])("preserves durable %s truth while disabling capture actions", async status => {
    recovery.protectionStatus = status;
    recovery.canRefreshConsent = true;
    recovery.canVerifyExistingCard = true;
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ ok: true, capturePaused: true, protectionStatus: status, cardRequired: status !== "not_required", alreadySaved: status === "saved", canRetry: false, canRefreshConsent: false, canVerifyExistingCard: false, consent: null });
    expect(mocks.consent).not.toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith("bookings", "id", bookingId);
    expect(eq).toHaveBeenCalledWith("bookings", "salon_id", salonId);
  });

  it("keeps existing card and cancellation facts separate from a pause", async () => {
    recovery.protectionStatus = "saved";
    booking.status = "cancelled";
    expect(await (await GET(request())).json()).toMatchObject({ capturePaused: true, alreadySaved: true, cancelled: true });
    expect(mocks.consent).not.toHaveBeenCalled();
  });

  it("restores existing consent recovery when capture is active", async () => {
    vi.stubEnv("NAILIQ_CARD_SAVE_DISPATCH_DISABLED", "false");
    recovery.canVerifyExistingCard = true;
    expect(await (await GET(request())).json()).toMatchObject({ capturePaused: false, cardRequired: true, canRetry: true, canVerifyExistingCard: true, consent: { version: "synthetic-policy-v2" } });
    expect(mocks.consent).toHaveBeenCalledExactlyOnceWith(recovery);
  });

  it("does not expose booking metadata to a wrong or expired capability", async () => {
    mocks.inspect.mockResolvedValue({ ok: false, code: "expired_or_revoked" });
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, code: "expired_or_revoked" });
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.consent).not.toHaveBeenCalled();
  });

  it("keeps the inspection rate limit during a capture pause", async () => {
    mocks.rate.mockResolvedValue("limited");
    expect((await GET(request())).status).toBe(429);
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.db).not.toHaveBeenCalled();
  });
});

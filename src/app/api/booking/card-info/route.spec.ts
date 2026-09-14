import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), recovery: vi.fn(), rate: vi.fn(), db: vi.fn(), eq: vi.fn() }));
vi.mock("@/shared/booking/bookingManagementCapabilities", () => ({ inspectBookingManagementCapability: mocks.inspect }));
vi.mock("@/shared/booking/bookingManagementRateLimit", () => ({ consumeBookingManagementRateLimit: mocks.rate }));
vi.mock("@/shared/booking/bookingCardRecovery", () => ({ inspectCardRecovery: mocks.recovery }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.db }));

import { GET } from "./route";

const salonId = "55650000-0000-4000-8000-000000000001";
const bookingId = "55650000-0000-4000-8000-000000000002";
const request = () => new Request(`https://qa.example.test/api/booking/card-info?token=${bookingId}&salonId=untrusted-tenant`);
let salon: { name: string; currency_code: string; brand_color: unknown; theme_mode: unknown };
let booking: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  salon = { name: "Synthetic Salon", currency_code: "CAD", brand_color: "#184A56", theme_mode: "dark" };
  booking = { noshow_fee_cents: 1000, noshow_card_id: "card_synthetic", noshow_customer_id: "customer_synthetic",
    noshow_card_brand: "VISA", noshow_card_last4: "1111", card_protection_status: "saved" };
  mocks.rate.mockResolvedValue("allowed");
  mocks.recovery.mockResolvedValue({ ok: true, context: { bookingId, salonId, protectionStatus: "saved" } });
  mocks.inspect.mockResolvedValue({ ok: true, inspection: {
    context: { bookingId, salonId },
    cardManage: { hasCard: true, cardBrand: "VISA", cardLast4: "1111", cardFingerprint: "a".repeat(64), chargeStatus: null },
  } });
  mocks.db.mockReturnValue({ from: (table: string) => {
    const builder = {
      select: () => builder,
      eq: (...args: unknown[]) => { mocks.eq(table, ...args); return builder; },
      maybeSingle: async () => ({ data: table === "salons" ? salon : booking, error: null }),
    };
    return builder;
  } });
});

describe("saved card theme metadata boundary", () => {
  it("reads theme from the capability's tenant and keeps the response private", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ ok: true, hasCard: true, brandColor: "#184A56", themeMode: "dark" });
    expect(mocks.eq).toHaveBeenCalledWith("salons", "id", salonId);
    expect(mocks.eq).toHaveBeenCalledWith("bookings", "salon_id", salonId);
    expect(mocks.eq.mock.calls.flat()).not.toContain("untrusted-tenant");
  });

  it.each(["red; background:url(https://untrusted.example)", "var(--external)", "#123", "#000000;", null])("rejects unsafe or malformed theme color %s", async (color) => {
    salon.brand_color = color;
    salon.theme_mode = "arbitrary-class";
    expect(await (await GET(request())).json()).toMatchObject({ brandColor: "#D4AF37", themeMode: "dark" });
  });

  it("accepts explicit light mode without changing card receipt fields", async () => {
    salon.theme_mode = "light";
    expect(await (await GET(request())).json()).toMatchObject({ themeMode: "light", brand: "VISA", last4: "1111", cardFingerprint: "a".repeat(64) });
  });

  it("does not read or expose any tenant metadata for a consumed capability", async () => {
    mocks.inspect.mockResolvedValue({ ok: false, code: "token_consumed" });
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, code: "token_consumed" });
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.recovery).not.toHaveBeenCalled();
  });
});

describe("stored card and protection truth are separate", () => {
  it.each(["VISA", "MASTERCARD", "AMEX", "DISCOVER", "JCB", "DINERS", "UNIONPAY"])(
    "accepts a saved Stripe receipt normalized to %s by durable completion", async (brand) => {
      booking.noshow_card_id = "pm_synthetic";
      booking.noshow_customer_id = "cus_synthetic";
      booking.noshow_card_brand = brand;
      const inspection = await mocks.inspect();
      inspection.inspection.cardManage.cardBrand = brand;
      expect(await (await GET(request())).json()).toMatchObject({ protectionStatus: "saved", protectionActive: true, brand, feeLabel: "10.00 CAD" });
    },
  );

  it("activates protection only from a saved durable receipt with matching metadata", async () => {
    const body = await (await GET(request())).json();
    expect(body).toMatchObject({ hasCard: true, protectionStatus: "saved", protectionActive: true,
      brand: "VISA", last4: "1111", feeLabel: "10.00 CAD", cardFingerprint: "a".repeat(64) });
    expect(body).not.toHaveProperty("noshow_card_id");
    expect(body).not.toHaveProperty("noshow_customer_id");
    expect(mocks.recovery).toHaveBeenCalledWith(bookingId);
  });

  it.each(["manual_review", "reconciliation_pending", "saving", "retry_required", "awaiting_card", "not_required"])(
    "a physical card with %s protection remains removable but never claims a collectible fee", async (status) => {
      mocks.recovery.mockResolvedValue({ ok: true, context: { bookingId, salonId, protectionStatus: status } });
      booking.card_protection_status = status;
      expect(await (await GET(request())).json()).toMatchObject({ hasCard: true, protectionStatus: status,
        protectionActive: false, feeLabel: "", brand: "VISA", last4: "1111", cardFingerprint: "a".repeat(64) });
    },
  );

  it.each([
    { noshow_customer_id: null }, { noshow_card_id: "" }, { noshow_card_id: "bad card" },
    { noshow_card_brand: "MASTERCARD" }, { noshow_card_last4: "2222" }, { card_protection_status: "manual_review" },
  ])("fails closed when the saved read and card row disagree: %j", async (patch) => {
    Object.assign(booking, patch);
    expect(await (await GET(request())).json()).toMatchObject({ protectionStatus: "manual_review", protectionActive: false, feeLabel: "" });
  });

  it("does not return arbitrary card labels or malformed last4 from legacy metadata", async () => {
    const inspection = await mocks.inspect();
    inspection.inspection.cardManage.cardBrand = "private@example.test";
    inspection.inspection.cardManage.cardLast4 = "4111111111111111";
    expect(await (await GET(request())).json()).toMatchObject({ brand: "", last4: "",
      protectionStatus: "manual_review", protectionActive: false, feeLabel: "" });
  });

  it.each(["bookingId", "salonId"])("does not join recovery from a different %s", async (field) => {
    mocks.recovery.mockResolvedValue({ ok: true, context: { bookingId, salonId, protectionStatus: "saved", [field]: "different-scope" } });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: "management_unavailable" });
  });

  it("a protection-read outage never falls back to raw card existence", async () => {
    mocks.recovery.mockResolvedValue({ ok: false, code: "management_unavailable" });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: "management_unavailable" });
  });

  it("does not inspect tenant data when rate limiting denies the request", async () => {
    mocks.rate.mockResolvedValue("limited");
    const response = await GET(request());
    expect(response.status).toBe(429);
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.recovery).not.toHaveBeenCalled();
    expect(mocks.db).not.toHaveBeenCalled();
  });
});

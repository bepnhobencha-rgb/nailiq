import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ quote: vi.fn(), db: vi.fn(), provider: vi.fn(), config: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/integrations/square/looseDb", () => ({ looseServiceClient: mocks.db }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: mocks.provider }));
vi.mock("@/shared/integrations/square/client", () => ({ getSquareConfig: mocks.config }));
vi.mock("@/shared/release/v1IntegrationScope", () => ({ v1AllowsNoShowCardOnFile: () => true }));
vi.mock("@/shared/booking/publicBookingQuoteServer", async original => ({
  ...await original<typeof import("@/shared/booking/publicBookingQuoteServer")>(), resolvePublicBookingQuote: mocks.quote,
}));
import { resolveNoShowCardRequirement } from "../resolveNoShowCardRequirement";
const salonId = "11111111-1111-4111-8111-111111111111";
const serviceId = "22222222-2222-4222-8222-222222222222";
const foreignId = "44444444-4444-4444-8444-444444444444";
const fingerprint = "a".repeat(64);
const intent = {
  salonId, serviceId, resolvedStaffId: "33333333-3333-4333-8333-333333333333",
  startTimeUtc: "2026-09-14T16:00:00Z", endTimeUtc: "2026-09-14T16:45:00Z",
  clientPhone: "12505550188", clientEmail: "synthetic-fee@example.com", applyEmailDiscount: true,
};
const args = { salonId, serviceId, clientPhone: intent.clientPhone, individualIntent: intent, individualPricingFingerprint: fingerprint };
function quote(price = 4300) { return { ok: true, quote: { salonId, serviceId, pricingFingerprint: fingerprint, serviceFinalCents: price, addonCents: 2000, taxCents: 315, totalCents: price + 2315 } }; }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("NAILIQ_CARD_SAVE_DISPATCH_DISABLED", "false");
  mocks.provider.mockResolvedValue({ kind: "square" });
  mocks.config.mockResolvedValue({ applicationId: "qa", locationId: "qa", environment: "sandbox" });
  mocks.quote.mockResolvedValue(quote());
  mocks.db.mockReturnValue({ from(table: string) {
    if (table === "salons") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { noshow_protection_enabled: true, noshow_fee_percent: 20, noshow_require_new_customer: true } }) }) }) };
    if (table === "bookings") return { select: () => ({ eq: () => ({ eq: () => ({ not: () => ({ limit: async () => ({ data: [] }) }) }) }) }) };
    if (table === "services") return { select: () => ({ in: async () => ({ data: [{ id: serviceId, price_cents: 4500 }] }) }) };
    throw Error("Unexpected table");
  } });
});
afterEach(() => vi.unstubAllEnvs());
describe("individual consent uses the committed service price", () => {
  it("shows $8.60 for a $43 discounted service, excluding add-ons and tax", async () => {
    expect(await resolveNoShowCardRequirement(args)).toMatchObject({ required: true, feeCents: 860 });
    expect(mocks.quote).toHaveBeenCalledOnce();
  });
  it.each([4500, 3871, 0])("uses authoritative final price %i including voucher allocation", async price => {
    mocks.quote.mockResolvedValue(quote(price));
    expect(await resolveNoShowCardRequirement(args)).toMatchObject(price ? { required: true, feeCents: Math.round(price * .2) } : { required: false });
  });
  it.each(["salon", "phone", "service", "missing-fingerprint", "stale", "malformed", "failed", "foreign-quote", "foreign-service-quote", "mixed-group", "mixed-sequence"])("rejects %s without catalog fallback", async kind => {
    const input = { ...args, individualIntent: { ...intent } };
    if (kind === "salon") input.salonId = foreignId;
    if (kind === "phone") input.clientPhone = "12505550189";
    if (kind === "service") input.serviceId = foreignId;
    if (kind === "missing-fingerprint") input.individualPricingFingerprint = "";
    if (kind === "stale") input.individualPricingFingerprint = "b".repeat(64);
    if (kind === "malformed") input.individualIntent.endTimeUtc = "bad";
    if (kind === "failed") mocks.quote.mockResolvedValue({ ok: false, code: "quote_unavailable" });
    if (kind === "foreign-quote") mocks.quote.mockResolvedValue({ ...quote(), quote: { ...quote().quote, salonId: foreignId } });
    if (kind === "foreign-service-quote") mocks.quote.mockResolvedValue({ ...quote(), quote: { ...quote().quote, serviceId: foreignId } });
    expect(await resolveNoShowCardRequirement({ ...input, ...(kind === "mixed-group" ? { groupIntent: {} } : {}), ...(kind === "mixed-sequence" ? { sequenceIntent: {} } : {}) })).toEqual({ required: false });
  });
});

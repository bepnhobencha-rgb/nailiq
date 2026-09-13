import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ exchange: vi.fn(), requirement: vi.fn(), pending: vi.fn(), resolve: vi.fn(), inspect: vi.fn() }));
vi.mock("@/shared/booking/bookingManagementCapabilities", () => ({ exchangePublicBookingCardManagementCapability: m.exchange, inspectBookingManagementCapability: m.inspect }));
vi.mock("@/shared/noshow/ensureNoShowCardRequirement", () => ({ ensureNoShowCardRequirement: m.requirement }));
vi.mock("@/shared/booking/bookingCardContinuation", () => ({ recordCommittedBookingCardPending: m.pending, resolveCommittedBookingCardContinuation: m.resolve }));
vi.mock("@/shared/lib/inAppRateLimit", () => ({ clientIp: () => "test", durableRateLimitKey: () => "test", isOverRateLimit: () => false }));
vi.mock("@/shared/release/v1IntegrationScope", () => ({ v1AllowsNoShowCardOnFile: () => true }));
import { POST } from "./route";
const body = { salonId: "11111111-1111-4111-8111-111111111111", bookingId: "21111111-1111-4111-8111-111111111111", idempotencyKey: "31111111-1111-4111-8111-111111111111", pricingFingerprint: "a".repeat(64), includeReceipt: true };
const request = () => new Request("https://qa.test/api/booking/card-capability", { method: "POST", headers: { origin: "https://qa.test", "content-type": "application/json" }, body: JSON.stringify(body) });
describe("committed capability continuation scope", () => {
  beforeEach(() => { vi.clearAllMocks(); m.inspect.mockResolvedValue({ok: true, inspection: {context: {salonId: body.salonId, bookingId: body.bookingId}, booking: {status: "confirmed", salonName: "QA", startTimeUtc: "2026-09-15T19:00:00+00:00", salonTimezone: "America/Vancouver", serviceName: "Manicure", sequenceReceipt: null}}}); m.exchange.mockResolvedValue({ ok: true, capability: { scopeKind: "organizer_own", tokenId: "41111111-1111-4111-8111-111111111111" } }); });
  it.each([true, false])("uses validated organizer scope, required=%s", async (required) => {
    m.requirement.mockResolvedValue({ required });
    const r = await POST(request());
    expect(r.status).toBe(200);
    expect(required ? m.pending : m.resolve).toHaveBeenCalledWith(expect.objectContaining({ scope: "group_organizer" }));
  });
  it("keeps group scope when assessment is unavailable", async () => {
    m.requirement.mockRejectedValue(new Error("read timeout"));
    expect((await POST(request())).status).toBe(503);
    expect(m.pending).toHaveBeenCalledWith(expect.objectContaining({ scope: "group_organizer", stage: "assessment" }));
  });
  it("does not assess or mint from a rejected member binding", async () => {
    m.exchange.mockResolvedValue({ ok: false, code: "create_binding_invalid" });
    expect((await POST(request())).status).toBe(404);
    expect(m.requirement).not.toHaveBeenCalled(); expect(m.pending).not.toHaveBeenCalled();
  });
  it("preserves individual continuation scope", async () => {
    m.exchange.mockResolvedValue({ ok: true, capability: { scopeKind: "booking_own", tokenId: "41111111-1111-4111-8111-111111111111" } });
    m.requirement.mockResolvedValue({ required: true });
    expect((await POST(request())).status).toBe(200);
    expect(m.pending).toHaveBeenCalledWith(expect.objectContaining({ scope: "individual" }));
  });
  it.each(["timeout", "tenant", "booking", "cancelled", "malformed"])("never confirms a receipt after %s", async (kind) => {
    m.requirement.mockResolvedValue({required:false});
    if (kind === "timeout") m.inspect.mockRejectedValue(new Error("read failed"));
    else {
      const data = await m.inspect();
      if (kind === "tenant") data.inspection.context.salonId = "other";
      if (kind === "booking") data.inspection.context.bookingId = "other";
      if (kind === "cancelled") data.inspection.booking.status = "cancelled";
      if (kind === "malformed") data.inspection.booking.salonTimezone = "invalid-zone";
      m.inspect.mockResolvedValue(data);
    }
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ok:false,code:"management_unavailable"});
    expect(m.resolve).not.toHaveBeenCalled();
  });
  it("returns only the verified service sequence and minimal appointment details", async () => {
    m.requirement.mockResolvedValue({required:false});
    const data = await m.inspect();
    data.inspection.booking.sequenceReceipt = {segments:[{serviceName:"Manicure"},{serviceName:"Pedicure"}]};
    data.inspection.contact = "PRIVATE CONTACT";
    m.inspect.mockResolvedValue(data);
    const response = await POST(request());
    const value = await response.json();
    expect(value.receipt.services).toEqual(["Manicure","Pedicure"]);
    expect(Object.keys(value.receipt).sort()).toEqual(["salonName","services","startTimeUtc","timezone"]);
    expect(JSON.stringify(value)).not.toContain("PRIVATE CONTACT");
    expect(value.token).toBeNull();
  });

  it("accepts UUID case differences after canonical authority validation", async () => {
    m.requirement.mockResolvedValue({required:false});
    const data = await m.inspect();
    data.inspection.context.bookingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    m.inspect.mockResolvedValue(data);
    const req = new Request("https://qa.test/api/booking/card-capability", {method:"POST",headers:{origin:"https://qa.test","content-type":"application/json"},body:JSON.stringify({...body,bookingId:data.inspection.context.bookingId.toUpperCase()})});
    expect((await POST(req)).status).toBe(200);
  });

});

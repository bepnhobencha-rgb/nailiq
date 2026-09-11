import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), config: vi.fn(), read: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/shared/integrations/square/client", () => ({ getSquareConfig: mocks.config, readSquareCardById: mocks.read }));
import { verifyLegacyBookingCard } from "../verifyLegacyBookingCard";
import { buildNoShowConsentPolicy } from "@/shared/noshow/noShowConsentPolicy";
import { CardDeliveryError } from "@/shared/integrations/payments/cardDeliveryFailure";
const capabilityId = "55650000-0000-4000-8000-000000000021";
const snapshot = { booking_id: "55650000-0000-4000-8000-000000000101", salon_id: "55650000-0000-4000-8000-000000000001",
  card_id: "card_qa", customer_id: "customer_qa", merchant_id: "merchant_qa", environment: "sandbox", salon_name: "Synthetic QA",
  currency: "CAD", fee_cents: 1000, scope: "booking_member" as const,
  stored_policy: {en: "Please cancel with at least 24 hours notice.", vi: "Vui lòng báo trước ít nhất 24 giờ khi hủy lịch."} };
const policy = buildNoShowConsentPolicy({storedPolicy:snapshot.stored_policy,salonName:snapshot.salon_name,
  feeCents:snapshot.fee_cents,currency:snapshot.currency,scope:snapshot.scope});
const card = {cardId:"card_qa",customerId:"customer_qa",merchantId:"merchant_qa",enabled:true,brand:"VISA",last4:"4242"};
let complete: {data:unknown;error:unknown};
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("NAILIQ_CARD_SAVE_DISPATCH_DISABLED", "false");
  complete = {data:{ok:true},error:null};
  mocks.config.mockResolvedValue({merchantId:"merchant_qa",environment:"sandbox"}); mocks.read.mockResolvedValue(card);
  mocks.rpc.mockImplementation(async (name:string) => name === "inspect_booking_legacy_card" ? {data:{ok:true,snapshot},error:null} :
    name === "confirm_booking_legacy_card_verification" ? complete : {data:{ok:true},error:null});
});
afterEach(() => vi.unstubAllEnvs());
const diagnostics = () => mocks.rpc.mock.calls.filter(([name]) => name === "record_booking_legacy_card_check").map(([,args]) => args);
describe("Legacy card verification without provider mutations", () => {
  it("completes only the exact read receipt and policy version; does not pass raw provider fields", async () => {
    mocks.read.mockResolvedValue({...card,billing_address:"PRIVATE_PII",exp_year:2030});
    expect(await verifyLegacyBookingCard(capabilityId,policy.version!)).toEqual({ok:true});
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({environment:"sandbox"}),"card_qa","customer_qa");
    const completed = mocks.rpc.mock.calls.find(([name]) => name === "confirm_booking_legacy_card_verification")![1];
    expect(completed.p_expected_snapshot).toEqual(snapshot);
    expect(completed.p_consent_meta.policyVersion).toBe(policy.version);
    expect(JSON.stringify(completed)).not.toMatch(/PRIVATE_PII|exp_year|source_token|access_token/);
    expect(diagnostics()[0]).toMatchObject({p_code:"legacy_card_verified",p_outcome:"found"});
  });
  it("rejects a stale policy before reading Square or writing consent", async () => {
    expect(await verifyLegacyBookingCard(capabilityId,"nsp_"+"b".repeat(64))).toEqual({ok:false});
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("expired, foreign or unresolved capability cannot read a card", async () => {
    mocks.rpc.mockResolvedValue({data:{ok:false,code:"verification_unavailable"},error:null});
    expect((await verifyLegacyBookingCard(capabilityId,policy.version!)).ok).toBe(false); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("pause stops even read-and-certify before database work", async () => {
    vi.stubEnv("NAILIQ_CARD_SAVE_DISPATCH_DISABLED","true");
    expect((await verifyLegacyBookingCard(capabilityId,policy.version!)).ok).toBe(false);expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.read).not.toHaveBeenCalled();
  });
  it("changed provider account fails at configuration and records no secrets", async () => {
    mocks.config.mockResolvedValue({merchantId:"another_merchant",environment:"sandbox",accessToken:"PRIVATE_TOKEN"});
    expect((await verifyLegacyBookingCard(capabilityId,policy.version!)).ok).toBe(false);expect(mocks.read).not.toHaveBeenCalled();
    expect(diagnostics()[0]).toMatchObject({p_stage:"configuration",p_code:"square_config_unavailable"});
    expect(JSON.stringify(diagnostics())).not.toContain("PRIVATE_TOKEN");
  });
  it("a read timeout is recorded separately from not-found and cannot certify a card", async () => {
    mocks.read.mockRejectedValue(new TypeError("timeout PRIVATE_TOKEN PRIVATE_PHONE"));
    expect((await verifyLegacyBookingCard(capabilityId,policy.version!)).ok).toBe(false);
    expect(diagnostics()[0]).toMatchObject({p_stage:"reconciliation",p_code:"reconciliation_read_failed",p_outcome:"read_failed"});
    expect(mocks.rpc.mock.calls.some(([name]) => name === "confirm_booking_legacy_card_verification")).toBe(false);
    expect(JSON.stringify(diagnostics())).not.toMatch(/PRIVATE_/);
  });
  it("preserves safe HTTP codes but strips arbitrary provider fields", async () => {
    mocks.read.mockRejectedValue(new CardDeliveryError({stage:"reconciliation",code:"reconciliation_read_failed",httpStatus:403,
      squareCodes:["INSUFFICIENT_SCOPES","PRIVATE_EMAIL"],squareCategories:["AUTHENTICATION_ERROR","PRIVATE_PHONE"],retryability:"safe_retry"}));
    expect((await verifyLegacyBookingCard(capabilityId,policy.version!)).ok).toBe(false);
    expect(diagnostics()[0]).toMatchObject({p_http_status:403,p_square_codes:["INSUFFICIENT_SCOPES"],p_square_categories:["AUTHENTICATION_ERROR"]});
  });
  it("lost completion response permits another read, never another provider mutation", async () => {
    complete={data:null,error:{message:"PRIVATE_DB_ERROR"}};
    expect((await verifyLegacyBookingCard(capabilityId,policy.version!)).ok).toBe(false);
    expect(diagnostics()[0]).toMatchObject({p_stage:"database_completion",p_code:"database_completion_uncertain"});
    complete={data:{ok:true,idempotent:true},error:null};
    expect((await verifyLegacyBookingCard(capabilityId,policy.version!)).ok).toBe(true);expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it("a concurrent card or policy change rejects the snapshot without changing protection", async () => {
    complete={data:{ok:false,code:"verification_changed"},error:null};
    expect((await verifyLegacyBookingCard(capabilityId,policy.version!)).ok).toBe(false);
    expect(diagnostics()[0]).toMatchObject({p_code:"verification_changed",p_outcome:"changed"});
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const blocked = vi.hoisted(() => ({ db: vi.fn(), provider: vi.fn(), stripe: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: blocked.db }));
vi.mock("@/shared/integrations/square/looseDb", () => ({ looseServiceClient: blocked.db }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: blocked.provider }));
vi.mock("@/shared/lib/stripe", () => ({ getStripeClient: blocked.stripe }));
import { isCardCapturePaused } from "../cardCapturePause";
import { saveCardWithManagementCapability, createStripeSetupWithManagementCapability } from "../bookingCardManagement";
import { saveNoShowCardForBooking, reuseNoShowCardForBooking, autoAttachReturningCard } from "@/shared/integrations/square/noshow";
import { SquareProvider } from "@/shared/integrations/payments/square";
import { StripeProvider } from "@/shared/integrations/payments/stripe";
import { saveCardOnFile, type SquareConfig } from "@/shared/integrations/square/client";
const capabilityId = "55650000-0000-4000-8000-000000000001";
const input = { tokenId:capabilityId, requestId:capabilityId, provider:"square" as const, sourceToken:"synthetic-source", consent:true };
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("NAILIQ_CARD_SAVE_DISPATCH_DISABLED", "true");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("outbound_forbidden"); }));
  for (const fn of Object.values(blocked)) fn.mockImplementation(() => { throw new Error("unexpected_dependency"); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("schema-compatible card capture pause", () => {
  it.each([undefined,"false","1","true"])("interprets explicit release value %s", value => {
    vi.stubEnv("NAILIQ_CARD_SAVE_DISPATCH_DISABLED", value);
    expect(isCardCapturePaused()).toBe(value === "true");
  });
  it("stops Square, Stripe and setup capabilities before any database claim", async () => {
    expect(await saveCardWithManagementCapability(input)).toEqual({ok:false,code:"card_capture_paused"});
    expect(await saveCardWithManagementCapability({...input,provider:"stripe"})).toEqual({ok:false,code:"card_capture_paused"});
    expect(await createStripeSetupWithManagementCapability({tokenId:capabilityId,requestId:capabilityId})).toEqual({ok:false,code:"card_capture_paused"});
    expect(blocked.db).not.toHaveBeenCalled(); expect(blocked.provider).not.toHaveBeenCalled(); expect(blocked.stripe).not.toHaveBeenCalled();
  });
  it("stops legacy save, OTP reuse and automatic carry-forward before changing a reservation", async () => {
    expect(await saveNoShowCardForBooking(capabilityId,"synthetic-source",true)).toMatchObject({ok:false,reason:"card_capture_paused"});
    expect(await reuseNoShowCardForBooking(capabilityId,capabilityId,true)).toMatchObject({ok:false,reason:"card_capture_paused"});
    expect(await autoAttachReturningCard(capabilityId)).toEqual({attached:false,reason:"card_capture_paused"});
    expect(blocked.db).not.toHaveBeenCalled(); expect(blocked.provider).not.toHaveBeenCalled();
  });
  it("also fences direct provider save adapters and the Square vault writer", async () => {
    const cfg = {environment:"sandbox",merchantId:"QA_MERCHANT",locationId:"QA_LOCATION",currency:"CAD",accessToken:"synthetic-disabled"} as SquareConfig;
    const payload = {customer:{referenceId:"synthetic-reference"},sourceToken:"synthetic-source",idempotencyKey:"synthetic-key",cardReferenceId:"synthetic-card-reference"};
    await expect(new SquareProvider(cfg).saveCardOnFile(payload)).rejects.toThrow("card_capture_paused");
    await expect(new StripeProvider({} as never).saveCardOnFile(payload)).rejects.toThrow("card_capture_paused");
    await expect(saveCardOnFile(cfg,{customerId:"QA_CUSTOMER",sourceId:"synthetic-source",idempotencyKey:"synthetic-key",referenceId:"nq-card:55630000-0000-4000-8000-000000000050"})).rejects.toThrow("card_capture_paused");
    expect(fetch).not.toHaveBeenCalled(); expect(blocked.db).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], effects: [] as Array<() => void> }));
const mocks = vi.hoisted(() => ({ quote: vi.fn(), submit: vi.fn(), stableId: vi.fn(), requirement: vi.fn(), acknowledge: vi.fn(), rotate: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  function memo<T>(factory: () => T, deps?: readonly unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.values[index] as { deps?: readonly unknown[]; value: T } | undefined;
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      hooks.values[index] = { deps, value: factory() };
    }
    return (hooks.values[index] as { value: T }).value;
  }
  return {
    ...actual,
    useMemo: memo,
    useCallback: <T,>(callback: T, deps: readonly unknown[]) => memo(() => callback, deps),
    useRef: <T,>(initial: T) => {
      const index = hooks.cursor++;
      return (hooks.values[index] ??= { current: initial }) as { current: T };
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.values[index] as T, (next: T | ((current: T) => T)) => {
        hooks.values[index] = typeof next === "function" ? (next as (value: T) => T)(hooks.values[index] as T) : next;
      }] as const;
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.values[index] as { deps?: readonly unknown[]; cleanup?: () => void } | undefined;
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        hooks.effects.push(() => {
          previous?.cleanup?.();
          hooks.values[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/booking/bookingConfetti", () => ({ fireBookingConfetti: vi.fn() }));
vi.mock("@/shared/release/v1IntegrationScope", () => ({ v1AllowsNoShowCardOnFile: () => true }));
vi.mock("@/shared/noshow/resolveNoShowCardRequirement", () => ({ resolveNoShowCardRequirement: mocks.requirement }));
vi.mock("@/shared/booking/submitPublicBooking", () => ({ quotePublicBooking: mocks.quote, submitPublicBooking: mocks.submit, BookingConflictError: class extends Error {}, BookingPricingChangedError: class extends Error {} }));
vi.mock("@/shared/booking/publicBookingRequestId", () => ({ stablePublicBookingRequestId: mocks.stableId, acknowledgePublicBookingRequestId: mocks.acknowledge, rotatePublicBookingRequestId: mocks.rotate }));
vi.mock("@/shared/lib/supabase/publicClient", () => ({ createPublicClient: vi.fn(() => { throw new Error("Unexpected database access"); }) }));
vi.mock("@/shared/observability/errorReporter", () => ({ captureException: vi.fn() }));
import { useBookingFlowState } from "../useBookingFlowState";
import { bookingEn } from "@/shared/i18n/booking/en";
import type { BookingSalonMeta, BookingStaffItem } from "@/shared/booking/loadBookingServices";
import type { BookingServiceItem, BookingComboItem } from "@/shared/booking/catalog";
import type { PublicBookingPricingQuote } from "@/shared/booking/publicBookingPricing";
import type { BookingResult } from "@/shared/booking/submitPublicBooking";
import type { PaidPublicDeposit } from "@/shared/payments/publicDepositTypes";

const salonId="11111111-1111-4111-8111-111111111111";
const serviceId="22222222-2222-4222-8222-222222222222";
const staffId="33333333-3333-4333-8333-333333333333";
const emailSession="44444444-4444-4444-8444-444444444444";
const smsSession="55555555-5555-4555-8555-555555555555";
const salon: BookingSalonMeta = {
  id: salonId, name: "Synthetic Salon", opening_hours: null, booking_closed_dates: null,
  closureNotice: null, acceptingBookings: true, salonPhone: "+16045550192", privacyUrl: null, termsUrl: null,
  defaultLanguage: "en", logoUrl: null, timezone: "America/Vancouver", brandColor: "#b89b5e", themeMode: "light",
  currencyCode: "CAD", address: null, description: null, phoneOtpEnabled: false, voiceAiEnabled: false,
  aiTextReceptionistEnabled: false, groupBookingEnabled: true, multiServiceBookingEnabled: true,
  turnIqEnabled: false, bookingTimePeriodsEnabled: false, vertical: "nail_salon", publicSectionsEnabled: false,
  bookingImages: null, staffSelectionEnabled: true, bookingLeadMinutes: 0, groupTogetherThresholdMin: 30,
  referenceImageEnabled: false, healthAckRequired: false, emailLinksEnabled: true, resourcesEnabled: false, taxLines: [],
};
const services: BookingServiceItem[] = [{
  id: serviceId, name: "Synthetic Service", durationMinutes: 30, prepMinutes: 0, bufferMinutes: 0,
  totalMinutes: 30, priceCents: 5000, priceType: "fixed", priceMaxCents: null, priceDisplay: "$50.00",
  category: "other", description: null, isPopular: false, isFeatured: false, addonConcurrent: false,
  promoPriceCents: null, promoPriceDisplay: null, promoId: null, promoName: null,
}];
const combos: BookingComboItem[]=[];
const addons: BookingServiceItem[]=[];
const staff: BookingStaffItem[]=[{ id: staffId, name: "Synthetic Staff", job_role: "nail_tech" }];
const baseQuote: PublicBookingPricingQuote={
  pricingFingerprint: "a".repeat(64), salonId, serviceId, resolvedStaffId: staffId, resolvedStaffName: "Synthetic Staff",
  startTimeUtc: "2026-09-19T17:00:00.000Z", endTimeUtc: "2026-09-19T17:30:00.000Z", comboId: null,
  voucherId: null, voucherCode: null, currency: "CAD", serviceOriginalCents: 5000, serviceNetCents: 5000,
  serviceFinalCents: 5000, addonPreVoucherCents: 0, addonCents: 0, promoId: null, promoName: null,
  promoDiscountCents: 0, emailDiscountCents: 0, voucherDiscountCents: 0, preVoucherSubtotalCents: 5000,
  subtotalCents: 5000, taxCents: 0, totalCents: 5000, taxBreakdown: [], addonLines: [], discountLines: [],
};
let initialSession: string|null;
function FlowHarness() {
  return useBookingFlowState(bookingEn,"synthetic",services,combos,staff,salon,null,false,addons,
    "+16045550191",null,"Synthetic Guest","synthetic@example.test","en",true,false,initialSession);
}
function render() {
  hooks.cursor=0;
  const state=FlowHarness();
  hooks.effects.splice(0).forEach(effect=>effect());
  return state;
}
async function settle() {
  for(let i=0;i<10;i++){ await vi.advanceTimersByTimeAsync(150); render(); }
  return render();
}
async function confirm() {
  render().setServiceId(serviceId); render().setStaffId(staffId);
  render().setSelectedDate(new Date(2026,8,19,12)); render().setTimeSlot("10:00 AM");
  render().goVerifyDecided("none");
  const state=await settle();
  expect(state.step).toBe("confirm"); expect(state.pricingQuote).not.toBeNull();
  return state;
}
beforeEach(()=>{
  vi.useFakeTimers(); hooks.cursor=0; hooks.values=[]; hooks.effects=[]; vi.clearAllMocks(); initialSession=emailSession;
  vi.stubGlobal("window",{ location:{search:""},setTimeout,clearTimeout });
  vi.stubGlobal("fetch",vi.fn(async (url: string)=>{
    if(url.startsWith("/api/customer/")) return {ok:true,json:async()=>({found:false})};
    throw new Error(`Unexpected network ${url}`);
  }));
  mocks.stableId.mockResolvedValue("66666666-6666-4666-8666-666666666666");
  mocks.requirement.mockResolvedValue({ required: false });
  mocks.rotate.mockResolvedValue("88888888-8888-4888-8888-888888888888");
  mocks.quote.mockImplementation(async request=>request.emailCaptureDiscount?{
    ...baseQuote,pricingFingerprint:"b".repeat(64),emailDiscountCents:200,serviceNetCents:4800,
    serviceFinalCents:4800,preVoucherSubtotalCents:4800,subtotalCents:4800,totalCents:4800,
    discountLines:[{kind:"email_incentive",label:"Phone offer",amountCents:200}],
  }:baseQuote);
});
afterEach(()=>{
  for(const v of hooks.values) if(v&&typeof v==="object"&&"cleanup" in v) (v as {cleanup?:()=>void}).cleanup?.();
  vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();
});

describe("individual phone offer intent and payment safety",()=>{
  it("shows a committed booking without waiting for best-effort request ID cleanup",async()=>{
    await confirm();
    const result: BookingResult={
      bookingId:"99999999-9999-4999-8999-999999999999",serviceName:"Synthetic Service",
      startTimeUtc:baseQuote.startTimeUtc,endTimeUtc:baseQuote.endTimeUtc,status:"confirmed",
      price_cents:5000,staffName:"Synthetic Staff",addonServiceName:null,addonPriceCents:null,
      addons:[],servicePriceCents:5000,subtotalCents:5000,taxCents:0,totalCents:5000,
      currency:"CAD",discountLines:[],pricing:baseQuote,cardManagementToken:null,
      cardManagementRecoveryHref:null,cardManagementPending:false,
      confirmationDelivery:{sms:"not_requested",email:"not_requested"},
    };
    mocks.submit.mockResolvedValueOnce(result);
    // A browser Web Lock can remain pending after the server has committed.
    mocks.acknowledge.mockImplementationOnce(()=>new Promise<void>(()=>{}));

    await render().onConfirm();

    const state=render();
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(mocks.acknowledge).toHaveBeenCalledOnce();
    expect(state.step).toBe("done");
    expect(state.bookingResult?.bookingId).toBe(result.bookingId);
    expect(state.submitting).toBe(false);
  },2000);
  it("shows a committed booking even if optional Try-On attachment remains pending",async()=>{
    await confirm();
    (window.location as {search:string}).search="?tryon=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    mocks.submit.mockResolvedValueOnce({
      bookingId:"99999999-9999-4999-8999-999999999999",serviceName:"Synthetic Service",
      startTimeUtc:baseQuote.startTimeUtc,endTimeUtc:baseQuote.endTimeUtc,status:"confirmed",
      price_cents:5000,staffName:"Synthetic Staff",addonServiceName:null,addonPriceCents:null,
      addons:[],servicePriceCents:5000,subtotalCents:5000,taxCents:0,totalCents:5000,
      currency:"CAD",discountLines:[],pricing:baseQuote,cardManagementToken:null,
      cardManagementRecoveryHref:null,cardManagementPending:false,
      confirmationDelivery:{sms:"not_requested",email:"not_requested"},
    } satisfies BookingResult);
    vi.mocked(fetch).mockImplementationOnce(()=>new Promise<Response>(()=>{}));

    await render().onConfirm();

    const state=render();
    expect(fetch).toHaveBeenCalledWith("/api/nail-tryon/attach",expect.objectContaining({method:"POST"}));
    expect(state.step).toBe("done");
    expect(state.submitting).toBe(false);
  },2000);
  it("keeps OTP-off email guests at full price until an explicit SMS choice and requote; never auto-submits",async()=>{
    initialSession=null;
    let state=await confirm();
    expect(mocks.quote.mock.lastCall?.[0]).toMatchObject({emailCaptureDiscount:false,otpSessionId:null});
    expect(state.pricingQuote?.totalCents).toBe(5000);
    state.startDiscountVerification(); state=render();
    expect(state.discountVerifying).toBe(true);expect(state.pricingQuote).toBeNull();
    state.finishDiscountVerification(smsSession);state=await settle();
    expect(mocks.quote.mock.lastCall?.[0]).toMatchObject({emailCaptureDiscount:true,otpSessionId:smsSession});
    expect(mocks.requirement.mock.lastCall?.[0]).toMatchObject({individualIntent:{applyEmailDiscount:true,otpSessionId:smsSession}});
    expect(state.pricingQuote?.totalCents).toBe(4800); expect(mocks.submit).not.toHaveBeenCalled();
    state.skipPhoneDiscount();state=await settle();
    expect(mocks.quote.mock.lastCall?.[0]).toMatchObject({emailCaptureDiscount:false,otpSessionId:smsSession});
    expect(state.pricingQuote?.totalCents).toBe(5000); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("a failed offer quote preserves the requested offer and requires the customer's skip or SMS action",async()=>{
    await confirm(); mocks.quote.mockRejectedValueOnce(new Error("phone_verification_required"));
    render().startDiscountVerification();render().finishDiscountVerification(smsSession);
    const state=await settle();
    expect(state.pricingQuote).toBeNull();expect(state.pricingQuoteError).toBe("phone_verification_required");
    expect(state.emailDiscountRequested).toBe(true);expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("a personalized voucher denial exposes SMS recovery without changing the agreed quote",async()=>{
    const prior=await confirm();mocks.quote.mockRejectedValueOnce(new Error("phone_verification_required"));
    expect(await prior.handleApplyVoucher("PERSONAL",5000)).toEqual({error:"phone_verification_required"});
    const state=render();expect(state.pricingQuoteError).toBe("phone_verification_required");
    expect(state.pricingQuote).toEqual(prior.pricingQuote);expect(state.appliedVoucher).toBeNull();expect(mocks.submit).not.toHaveBeenCalled();
    state.skipPhoneDiscount();const skipped=await settle();
    expect(skipped.pricingQuoteError).toBeNull();expect(skipped.pricingQuote).toEqual(prior.pricingQuote);
    expect(mocks.quote).toHaveBeenCalledTimes(2);
  });
  it("an unpaid create rejection preserves draft, invalidates the quote, and never auto-creates after new SMS",async()=>{
    await confirm();render().startDiscountVerification();render().finishDiscountVerification(smsSession);await settle();
    mocks.submit.mockRejectedValueOnce(new Error("phone_verification_required"));
    await render().onConfirm();
    let state=render();expect(state.pricingQuote).toBeNull();expect(state.pricingQuoteError).toBe("phone_verification_required");
    expect(state.clientName).toBe("Synthetic Guest");expect(state.timeSlot).toBe("10:00 AM");expect(state.step).toBe("confirm");
    state.startDiscountVerification();render().finishDiscountVerification("77777777-7777-4777-8777-777777777777");state=await settle();
    expect(state.pricingQuote).not.toBeNull();expect(mocks.submit).toHaveBeenCalledTimes(1);
  });
  it.each(["deposit_booking_recovery_required", "booking_recovery_required", "deposit_compensation_pending", "deposit_binding_pending"])("preserves a paid deposit and exact quote/replay for %s",async(code)=>{
    await confirm();
    const paid:PaidPublicDeposit={operationId:"op-synthetic",paymentRequestId:"pay-synthetic",materialFingerprint:"c".repeat(64)};
    render().goDepositPaid(paid);let state=await settle();const priorQuote=state.pricingQuote;
    mocks.submit.mockRejectedValue(new Error(code));await state.onConfirm();
    state=render();expect(state.error).toBe(bookingEn.phoneOfferPaymentRecovery);expect(state.hasPaidDeposit).toBe(true);
    expect(state.depositRefundCompleted).toBe(false);
    expect(state.pricingQuote).toEqual(priorQuote);expect(state.step).toBe("confirm");
    state.startDiscountVerification();state.finishDiscountVerification(smsSession);state.skipPhoneDiscount();state=render();
    expect(state.discountVerifying).toBe(false);expect(state.emailDiscountRequested).toBe(false);expect(state.otpSessionId).toBe(emailSession);
    await state.onConfirm();expect(mocks.submit.mock.lastCall?.[0]).toMatchObject({paidDeposit:paid,idempotencyReplay:true,expectedPricingQuote:priorQuote});
    expect(mocks.submit).toHaveBeenCalledTimes(2);
  });
  it("releases only a verified refunded deposit, preserves draft and quote, and waits for an explicit fresh start",async()=>{
    await confirm();
    render().goDepositPaid({operationId:"refunded-op",paymentRequestId:"refunded-payment",materialFingerprint:"e".repeat(64)});
    let state=await settle();const priorQuote=state.pricingQuote;const quoteCalls=mocks.quote.mock.calls.length;const idCalls=mocks.stableId.mock.calls.length;
    mocks.submit.mockRejectedValueOnce(new Error("deposit_refund_completed"));await state.onConfirm();state=await settle();
    expect(state.depositRefundCompleted).toBe(true);expect(state.hasPaidDeposit).toBe(false);expect(state.pricingQuote).toEqual(priorQuote);
    expect(state.clientName).toBe("Synthetic Guest");expect(state.timeSlot).toBe("10:00 AM");expect(state.error).toBeNull();
    await state.onConfirm();state.startDiscountVerification();state.finishDiscountVerification(smsSession);state.skipPhoneDiscount();await settle();
    expect(mocks.submit).toHaveBeenCalledOnce();expect(mocks.quote).toHaveBeenCalledTimes(quoteCalls);expect(mocks.stableId).toHaveBeenCalledTimes(idCalls);expect(mocks.acknowledge).not.toHaveBeenCalled();expect(mocks.rotate).not.toHaveBeenCalled();
    mocks.rotate.mockRejectedValueOnce(new Error("storage failed"));await render().startFreshBookingAfterRefund();
    expect(render().depositRefundCompleted).toBe(true);expect(mocks.submit).toHaveBeenCalledOnce();expect(mocks.quote).toHaveBeenCalledTimes(quoteCalls);
    mocks.rotate.mockClear();
    await render().startFreshBookingAfterRefund();state=render();
    expect(mocks.rotate).toHaveBeenCalledOnce();expect(mocks.acknowledge).not.toHaveBeenCalled();expect(state.depositRefundCompleted).toBe(false);expect(state.step).toBe("verify");
    expect(state.pricingQuote).toBeNull();expect(state.otpSessionId).toBeNull();expect(state.clientName).toBe("Synthetic Guest");expect(state.timeSlot).toBe("10:00 AM");
    expect(mocks.quote).toHaveBeenCalledTimes(quoteCalls);expect(mocks.submit).toHaveBeenCalledOnce();
  });
  it("retains the payment-bound material and quote for replay even if later draft state changes",async()=>{
    await confirm();render().goDepositPaid({operationId:"paid-op",paymentRequestId:"paid-request",materialFingerprint:"e".repeat(64)});await settle();
    mocks.submit.mockRejectedValue(new Error("booking_recovery_required"));await render().onConfirm();
    const retained=mocks.submit.mock.lastCall?.[0].paidReplayMaterial;expect(retained).toMatchObject({clientName:"Synthetic Guest",expectedPricingFingerprint:baseQuote.pricingFingerprint});
    render().setClientName("Edited Draft");await settle();await render().onConfirm();
    expect(mocks.submit.mock.lastCall?.[0]).toMatchObject({idempotencyReplay:true,paidReplayMaterial:retained,paidReplayServiceName:"Synthetic Service",expectedPricingQuote:baseQuote});
  });
  it("a definite first-paid OTP preflight rejection permits fresh create only after new proof, then unknown stays replay-only",async()=>{
    await confirm();render().goDepositPaid({operationId:"paid-op",paymentRequestId:"paid-request",materialFingerprint:"e".repeat(64)});await settle();
    mocks.submit.mockRejectedValueOnce(new Error("otp_required"));await render().onConfirm();
    expect(render().step).toBe("otp");expect(render().hasPaidDeposit).toBe(true);
    render().goOtpNext(smsSession);await settle();mocks.submit.mockRejectedValue(new Error("booking_recovery_required"));await render().onConfirm();
    expect(mocks.submit.mock.lastCall?.[0]).toMatchObject({idempotencyReplay:false,otpSessionId:smsSession});
    await render().onConfirm();expect(mocks.submit.mock.lastCall?.[0]).toMatchObject({idempotencyReplay:true,otpSessionId:smsSession});
  });
  it("keeps the pre-provider rejection callback stable across renders and allows a fresh choice",async()=>{
    const first=render().handleDepositPhoneVerificationRequired;expect(render().handleDepositPhoneVerificationRequired).toBe(first);
    first();const state=render();expect(state.pricingQuoteError).toBe("phone_verification_required");expect(state.discountChoiceMade).toBe(false);
    expect(state.handleDepositPhoneVerificationRequired).toBe(first);expect(mocks.submit).not.toHaveBeenCalled();
  });
});

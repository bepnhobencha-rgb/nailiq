import type { ComponentProps, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], effects: [] as Array<() => void> }));
const mocks = vi.hoisted(() => ({ loadStripe: vi.fn(), replay: vi.fn() }));
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

vi.mock("@stripe/stripe-js/pure", () => ({ loadStripe: mocks.loadStripe }));
vi.mock("@stripe/react-stripe-js", () => ({ Elements: "mock-elements", PaymentElement: "mock-payment", useElements: vi.fn(), useStripe: vi.fn() }));
vi.mock("@/shared/payments/publicDepositReplayIdentity", () => ({ stablePublicDepositReplayIdentity: mocks.replay }));
vi.mock("@/components/booking/BookingFlowOtpPanel", () => ({ BookingFlowOtpPanel: "mock-otp" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/components/booking/NoShowCardCapture", () => ({ NoShowCardCapture: "mock-card" }));
vi.mock("@/components/booking/ConfirmStepCardCapture", () => ({ ConfirmStepCardCapture: "mock-confirm-card" }));
import { BookingFlowDepositPanel } from "../BookingFlowDepositPanel";
import { BookingPhoneDiscountChoice } from "../BookingPhoneDiscountChoice";
import { BookingFlowDonePanel } from "../BookingFlowDonePanel";
import { BookingFlowConfirmPanel } from "../BookingFlowConfirmPanel";
import { bookingEn } from "@/shared/i18n/booking/en";
import { bookingVi } from "@/shared/i18n/booking/vi";
import type { PublicBookingPricingQuote } from "@/shared/booking/publicBookingPricing";
const salonId="11111111-1111-4111-8111-111111111111";
const serviceId="22222222-2222-4222-8222-222222222222";
const staffId="33333333-3333-4333-8333-333333333333";
const baseQuote: PublicBookingPricingQuote={
  pricingFingerprint: "a".repeat(64), salonId, serviceId, resolvedStaffId: staffId, resolvedStaffName: "Synthetic Staff",
  startTimeUtc: "2026-09-19T17:00:00.000Z", endTimeUtc: "2026-09-19T17:30:00.000Z", comboId: null,
  voucherId: null, voucherCode: null, currency: "CAD", serviceOriginalCents: 5000, serviceNetCents: 5000,
  serviceFinalCents: 5000, addonPreVoucherCents: 0, addonCents: 0, promoId: null, promoName: null,
  promoDiscountCents: 0, emailDiscountCents: 0, voucherDiscountCents: 0, preVoucherSubtotalCents: 5000,
  subtotalCents: 5000, taxCents: 0, totalCents: 5000, taxBreakdown: [], addonLines: [], discountLines: [],
};

type Node=ReactElement<Record<string,unknown>>;
function nodes(value:unknown,out:Node[]=[]):Node[]{
  if(Array.isArray(value)) value.forEach(child=>nodes(child,out));
  else if(value&&typeof value==="object"&&"props"in value){out.push(value as Node);nodes((value as Node).props.children,out);}
  return out;
}
let deposit:ComponentProps<typeof BookingFlowDepositPanel>;
function renderDeposit(){hooks.cursor=0;const tree=nodes(BookingFlowDepositPanel(deposit));hooks.effects.splice(0).forEach(effect=>effect());return tree;}
async function settle(){for(let i=0;i<8;i++){await Promise.resolve();renderDeposit();}}
beforeEach(()=>{
  hooks.cursor=0;hooks.values=[];hooks.effects=[];vi.clearAllMocks();
  mocks.replay.mockResolvedValue({bookingRequestId:"booking-synthetic",paymentRequestId:"payment-synthetic",createdAt:1});
  deposit={salonId,pricingQuote:baseQuote,bookingRequestId:"booking-synthetic",clientPhone:"+16045550191",
    clientEmail:"synthetic@example.test",otpSessionId:null,onPaid:vi.fn(),onSkip:vi.fn(),onBack:vi.fn(),onPhoneVerificationRequired:vi.fn()};
  vi.stubGlobal("fetch",vi.fn(async()=>({ok:false,status:403,json:async()=>({error:"phone_verification_required"})})));
});
afterEach(()=>{
  for(const v of hooks.values)if(v&&typeof v==="object"&&"cleanup"in v)(v as {cleanup?:()=>void}).cleanup?.();
  vi.unstubAllGlobals();
});
describe("explicit phone offer choice and deposit boundary",()=>{
  it("locks price edits after payment, including URL voucher auto-apply, while retaining explicit confirmation",async()=>{
    vi.stubGlobal("window",{location:{search:"?code=PERSONAL"}});
    const onApply=vi.fn(),onBack=vi.fn(),onConfirm=vi.fn();
    hooks.cursor=0;
    const tree=nodes(BookingFlowConfirmPanel({t:bookingEn,shopLabel:"Synthetic Salon",shopSlug:"synthetic",materialLocked:true,
      service:{id:serviceId,name:"Synthetic Service",durationMinutes:30,prepMinutes:0,bufferMinutes:0,totalMinutes:30,
        priceCents:5000,priceType:"fixed",priceMaxCents:null,priceDisplay:"$50",category:"other",description:null,
        isPopular:false,isFeatured:false,addonConcurrent:false,promoPriceCents:null,promoPriceDisplay:null,promoId:null,promoName:null},
      confirmTimeLabel:"Synthetic time",staffSummaryLabel:"Synthetic Staff",clientName:"Synthetic Guest",clientPhone:"+16045550191",
      clientEmail:"synthetic@example.test",clientNotes:"",upsellCandidates:[],upsellGapMinutes:0,selectedAddonIds:[],selectedAddonsTotalMin:0,
      error:null,submitting:false,stepDir:1,pricingQuote:baseQuote,pricingQuoteLoading:false,pricingQuoteError:null,pricingReconfirmRequired:false,
      appliedVoucher:null,onApplyVoucher:onApply,onRemoveVoucher:vi.fn(),reducedMotion:true,stepTransition:{duration:0,ease:[0,0,1,1]},currency:"CAD",
      onToggleAddon:vi.fn(),onAddonRepickTime:vi.fn(),onClearAddons:vi.fn(),onBack,onConfirm,smsConsent:true,setSmsConsent:vi.fn(),
    }));
    hooks.effects.splice(0).forEach(effect=>effect());await Promise.resolve();
    expect(onApply).not.toHaveBeenCalled();expect(tree.some(n=>n.props.placeholder===bookingEn.voucherPlaceholder)).toBe(false);
    expect(tree.find(n=>n.props.onClick===onBack)?.props.disabled).toBe(true);
    const confirm=tree.find(n=>n.props["data-testid"]==="confirm-booking-btn");expect(confirm?.props.disabled).toBe(false);
    await (confirm?.props.onClick as ()=>Promise<void>)();expect(onConfirm).toHaveBeenCalledOnce();
  });
  it.each([bookingEn, bookingVi])("recovered booking completion presents email as unverified rather than processing",messages=>{
    hooks.cursor=0;
    const tree=nodes(BookingFlowDonePanel({ t:messages,shopLabel:"Synthetic Salon",service:undefined,staffName:"Synthetic Staff",
      displayStartUtc:baseQuote.startTimeUtc,displayEndUtc:baseQuote.endTimeUtc,bookingId:"44444444-4444-4444-8444-444444444444",
      cardManagementToken:null,cardManagementPending:false,confirmationDelivery:{sms:"unverified",email:"unverified"},
      salonPhone:null,salonTimezone:"America/Vancouver",pricing:baseQuote,currency:"CAD",onAddToCalendar:()=>false,onBookAnother:vi.fn(),
    }));
    const delivery=tree.find(n=>n.props["data-testid"]==="booking-email-delivery-status");
    expect(delivery?.props.children).toContain(messages.confirmationEmailUnverified);
    expect(delivery?.props.children).not.toContain(messages.confirmationEmailProcessing);
    expect(delivery?.props.children).not.toContain(messages.confirmationEmailNotRequested);
  });
  it.each([bookingEn,bookingVi])("renders a phone-only choice and a paid lock without claiming applied eligibility",messages=>{
    const props:ComponentProps<typeof BookingPhoneDiscountChoice>={t:messages,shopSlug:"synthetic",phone:"+16045550191",
      hasEmail:true,requested:true,verifying:false,onStart:vi.fn(),onVerified:vi.fn(),onSkip:vi.fn()};
    let tree=nodes(BookingPhoneDiscountChoice(props));
    expect(tree.find(n=>n.props.role==="status")?.props.children).toBe(messages.phoneDiscountRequested);
    (tree.find(n=>n.props["data-testid"]==="phone-discount-verify")?.props.onClick as ()=>void)();expect(props.onStart).toHaveBeenCalledOnce();
    tree=nodes(BookingPhoneDiscountChoice({...props,verifying:true}));const otp=tree.find(n=>(n.type as unknown)==="mock-otp");
    expect(otp?.props).toMatchObject({purpose:"phone",emailChannelEnabled:false,isOptional:true,onSkip:props.onSkip,onBack:props.onSkip});
    expect(otp?.props).not.toHaveProperty("clientEmail");
    tree=nodes(BookingPhoneDiscountChoice({...props,lockedReason:messages.phoneOfferPaidDepositHint}));
    expect(tree.some(n=>n.type==="button"||(n.type as unknown)==="mock-otp")).toBe(false);
    expect(tree.find(n=>n.type==="p")?.props.children).toBe(messages.phoneOfferPaidDepositHint);
  });
  it("requires an explicit phone offer for an email guest and routes pre-provider denial to the choice",async()=>{
    renderDeposit();await settle();
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toMatchObject({applyEmailDiscount:false,otpSessionId:null});
    expect(deposit.onPhoneVerificationRequired).toHaveBeenCalledOnce();
    expect(deposit.onSkip).not.toHaveBeenCalled();expect(deposit.onPaid).not.toHaveBeenCalled();expect(mocks.loadStripe).not.toHaveBeenCalled();
  });
  it("forwards explicit SMS proof and offer to the deposit request without initiating provider SDK on denial",async()=>{
    deposit={...deposit,applyEmailDiscount:true,otpSessionId:"55555555-5555-4555-8555-555555555555"};
    renderDeposit();await settle();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toMatchObject({applyEmailDiscount:true,otpSessionId:deposit.otpSessionId});
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();expect(mocks.loadStripe).not.toHaveBeenCalled();expect(deposit.onPhoneVerificationRequired).toHaveBeenCalledOnce();
  });
  it("resumes an already completed deposit receipt without another payment or a no-deposit skip",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,status:200,json:async()=>({required:true,paymentCompleted:true,
      operationId:"saved-operation",paymentRequestId:"saved-payment",materialFingerprint:"d".repeat(64)})})));
    renderDeposit();await settle();
    expect(deposit.onPaid).toHaveBeenCalledExactlyOnceWith({operationId:"saved-operation",paymentRequestId:"saved-payment",materialFingerprint:"d".repeat(64)});
    expect(deposit.onSkip).not.toHaveBeenCalled();expect(deposit.onPhoneVerificationRequired).not.toHaveBeenCalled();expect(mocks.loadStripe).not.toHaveBeenCalled();
  });
});

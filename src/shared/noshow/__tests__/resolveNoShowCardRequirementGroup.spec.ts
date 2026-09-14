import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({quote:vi.fn(),db:vi.fn(),provider:vi.fn(),config:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/shared/integrations/square/looseDb',()=>({looseServiceClient:mocks.db}));
vi.mock('@/shared/integrations/payments',()=>({resolvePaymentProvider:mocks.provider}));
vi.mock('@/shared/integrations/square/client',()=>({getSquareConfig:mocks.config}));
vi.mock('@/shared/release/v1IntegrationScope',()=>({v1AllowsNoShowCardOnFile:()=>true}));
vi.mock('@/shared/booking/groupBookingPricingServer',async importOriginal=>({...await importOriginal<typeof import('@/shared/booking/groupBookingPricingServer')>(),resolveGroupBookingQuote:mocks.quote}));
import {resolveNoShowCardRequirement} from '../resolveNoShowCardRequirement';
const salonId='11111111-1111-4111-8111-111111111111';const serviceId='22222222-2222-4222-8222-222222222222';
const member={serviceId,staffId:'33333333-3333-4333-8333-333333333333',startTimeUtc:'2026-09-14T16:00:00Z',endTimeUtc:'2026-09-14T16:45:00Z',clientName:'Synthetic',clientPhone:'12505550184'};
const intent={salonId,bookings:[member,{...member,clientName:'Synthetic Guest',clientPhone:null}],applyEmailDiscount:true};
const args={salonId,serviceId,clientPhone:'12505550184',groupIntent:intent,groupPricingFingerprint:'a'.repeat(64)};
let wholeParty=true;
beforeEach(()=>{
 vi.clearAllMocks();vi.stubEnv('NAILIQ_CARD_SAVE_DISPATCH_DISABLED','false');wholeParty=true;
 mocks.provider.mockResolvedValue({kind:'square'});mocks.config.mockResolvedValue({applicationId:'qa',locationId:'qa',environment:'sandbox'});
 mocks.quote.mockResolvedValue({ok:true,quote:{salonId,pricingFingerprint:'a'.repeat(64),memberQuotes:[{serviceFinalCents:4300},{serviceFinalCents:4500}]}});
 mocks.db.mockReturnValue({from(table:string){if(table==='salons')return {select:()=>({eq:()=>({maybeSingle:async()=>({data:{noshow_protection_enabled:true,noshow_fee_percent:20,noshow_group_whole_party:wholeParty,noshow_require_new_customer:true}})})})};if(table==='bookings')return {select:()=>({eq:()=>({eq:()=>({not:()=>({limit:async()=>({data:[]})})})})})};throw Error('catalog price must not determine quoted group fee');}});
});
afterEach(()=>vi.unstubAllEnvs());
describe('authoritative group no-show fee',()=>{
 it('uses $88 discounted base to show $17.60 consent',async()=>expect(await resolveNoShowCardRequirement(args)).toMatchObject({required:true,feeCents:1760}));
 it('uses organizer discounted service when whole-party protection is off',async()=>{wholeParty=false;expect(await resolveNoShowCardRequirement(args)).toMatchObject({required:true,feeCents:860});});
 it('keeps repeated services as separate priced members',async()=>{mocks.quote.mockResolvedValue({ok:true,quote:{salonId,pricingFingerprint:'a'.repeat(64),memberQuotes:[{serviceFinalCents:4300},{serviceFinalCents:4500},{serviceFinalCents:4500}]}});expect(await resolveNoShowCardRequirement({...args,groupIntent:{...intent,bookings:[...intent.bookings,{...member,clientPhone:null}]}})).toMatchObject({feeCents:2660});});
 it.each(['foreign-tenant','foreign-phone','foreign-service','missing-fingerprint','stale-fingerprint','quote-failed','mixed-sequence'])('rejects %s',async kind=>{
  const input={...args};
  if(kind==='foreign-tenant')input.salonId='44444444-4444-4444-8444-444444444444';
  if(kind==='foreign-phone')input.clientPhone='12505550185';
  if(kind==='foreign-service')input.serviceId='44444444-4444-4444-8444-444444444444';
  if(kind==='missing-fingerprint')input.groupPricingFingerprint='';
  if(kind==='stale-fingerprint')input.groupPricingFingerprint='b'.repeat(64);
  if(kind==='quote-failed')mocks.quote.mockResolvedValue({ok:false,code:'quote_unavailable'});
  expect(await resolveNoShowCardRequirement({...input,...(kind==='mixed-sequence'?{sequenceIntent:{}}:{})})).toEqual({required:false});
 });
 it('rejects a quote with foreign salon binding',async()=>{mocks.quote.mockResolvedValue({ok:true,quote:{salonId:'other',pricingFingerprint:'a'.repeat(64),memberQuotes:[{serviceFinalCents:8800}]}});expect(await resolveNoShowCardRequirement(args)).toEqual({required:false});});
});

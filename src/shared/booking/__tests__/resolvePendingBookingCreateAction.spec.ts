import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({headers:vi.fn(),limited:vi.fn(),rpc:vi.fn(),db:vi.fn()}));
vi.mock('next/headers',()=>({headers:m.headers}));
vi.mock('@/shared/lib/inAppRateLimit',()=>({clientIpFromHeaders:()=> 'test',durableRateLimitKey:()=> 'test',isOverRateLimit:m.limited}));
vi.mock('@/shared/lib/supabase/serviceRole',()=>({createServiceRoleClient:m.db}));
import {resolvePendingBookingCreateAction as resolve} from '../resolvePendingBookingCreateAction';
const b={kind:'individual',salonId:'11111111-1111-4111-8111-111111111111',idempotencyKey:'22222222-2222-4222-8222-222222222222',pricingFingerprint:'a'.repeat(64)};
beforeEach(()=>{vi.clearAllMocks();m.headers.mockResolvedValue(new Headers({origin:'https://qa.test',host:'qa.test'}));m.limited.mockResolvedValue(false);m.db.mockReturnValue({rpc:m.rpc});m.rpc.mockResolvedValue({data:{status:'retired',salon_slug:'e2e-test'},error:null});});
describe('customer explicit create resolution',()=>{
 it.each(['individual','sequence','group'])('binds %s without returning a provider or booking token',async kind=>{expect(await resolve({...b,kind})).toEqual({status:'retired',salonPath:'/e2e-test'});expect(m.rpc).toHaveBeenCalledWith('resolve_pending_booking_create',{p_salon_id:b.salonId,p_request_id:b.idempotencyKey,p_kind:kind,p_pricing_fingerprint:b.pricingFingerprint});});
 it.each([null,{...b,salonId:{toString:1}},{...b,kind:{toString:1}},{...b,kind:'unknown'},{...b,sourceToken:'SECRET'},{...b,idempotencyKey:'bad'}])('rejects invalid/extra input before DB',async input=>{expect(await resolve(input)).toEqual({status:'unavailable'});expect(m.db).not.toHaveBeenCalled();});
 it('rejects cross origin',async()=>{m.headers.mockResolvedValue(new Headers({origin:'https://evil.test',host:'qa.test'}));expect(await resolve(b)).toEqual({status:'unavailable'});expect(m.db).not.toHaveBeenCalled();});
 it('rejects missing origin',async()=>{m.headers.mockResolvedValue(new Headers({host:'qa.test'}));expect(await resolve(b)).toEqual({status:'unavailable'});expect(m.db).not.toHaveBeenCalled();});
 it('fails closed on rate limit',async()=>{m.limited.mockResolvedValue(true);expect(await resolve(b)).toEqual({status:'unavailable'});expect(m.rpc).not.toHaveBeenCalled();});
 it.each(['error','throw','malformed','redirect'])('does not enable retry for %s',async mode=>{if(mode==='throw')m.rpc.mockRejectedValue(Error('SECRET'));else m.rpc.mockResolvedValue(mode==='error'?{error:{message:'SECRET'},data:null}:{error:null,data:mode==='redirect'?{status:'retired',salon_slug:'//evil.test'}:{status:'unknown'}});expect(await resolve(b)).toEqual({status:'unavailable'});});
 it('preserves pending while writer holds fence',async()=>{m.rpc.mockResolvedValue({data:{status:'pending'},error:null});expect(await resolve(b)).toEqual({status:'pending'});});
 it('returns existence without renewing management authority',async()=>{m.rpc.mockResolvedValue({data:{status:'booking_exists',salon_slug:'e2e-test',token_id:'SECRET'},error:null});expect(await resolve(b)).toEqual({status:'booking_exists',salonPath:'/e2e-test'});});
});

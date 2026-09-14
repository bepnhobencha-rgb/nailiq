import { describe, expect, it } from "vitest";
import { stablePublicBookingRequestId, type PublicBookingRequestMaterial } from "../publicBookingRequestId";
import { isBookingCreateRetired, rememberRetiredBookingCreate } from "../retiredBookingCreate";
const oldId="11111111-1111-4111-8111-111111111111",nextId="22222222-2222-4222-8222-222222222222";
function storage(){const m=new Map<string,string>();return {getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>{m.set(k,v);},removeItem:(k:string)=>{m.delete(k);}};}
const material:PublicBookingRequestMaterial={salonId:oldId,serviceId:oldId,staffId:oldId,clientName:'Synthetic',clientPhone:'16045550196',startTimeUtc:'2026-09-14T20:00:00Z',endTimeUtc:'2026-09-14T21:00:00Z',clientNotes:null,addonServiceIds:[],clientEmail:null,resourceId:null,comboId:null,voucherId:null,applyEmailDiscount:false,expectedPricingFingerprint:'a'.repeat(64)};
describe('retired request local hint',()=>{
 it('keeps an unresolved stable key unchanged',async()=>{const s=storage();expect(await stablePublicBookingRequestId(material,{storage:s,locks:null,now:1,newId:()=>oldId})).toBe(oldId);expect(await stablePublicBookingRequestId(material,{storage:s,locks:null,now:2,newId:()=>nextId})).toBe(oldId);});
 it('uses a new stable key only after retirement, shared by subsequent calls',async()=>{const s=storage();await stablePublicBookingRequestId(material,{storage:s,locks:null,now:1,newId:()=>oldId});rememberRetiredBookingCreate(material.salonId, oldId,s);expect(await stablePublicBookingRequestId(material,{storage:s,locks:null,now:2,newId:()=>nextId})).toBe(nextId);expect(await stablePublicBookingRequestId(material,{storage:s,locks:null,now:3,newId:()=>oldId})).toBe(nextId);});
 it('does not retire another request',()=>{const s=storage();rememberRetiredBookingCreate(material.salonId, oldId,s);expect(isBookingCreateRetired(material.salonId, nextId,s)).toBe(false);});
 it('fails closed when retirement hint cannot be persisted',()=>{expect(()=>rememberRetiredBookingCreate(material.salonId, oldId,{getItem:()=>null,setItem:()=>{}})).toThrow('retirement_storage_unavailable');});
 it('does not cross salon boundaries',()=>{const s=storage();rememberRetiredBookingCreate(material.salonId,oldId,s);expect(isBookingCreateRetired(nextId,oldId,s)).toBe(false);});
 it('rejects malformed identities',()=>{expect(()=>rememberRetiredBookingCreate(material.salonId, 'bad',storage())).toThrow();expect(isBookingCreateRetired(material.salonId, 'bad',storage())).toBe(false);});
});

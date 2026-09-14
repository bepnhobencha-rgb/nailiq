import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPendingGroupCreate, dispatchGroupCreate, parsePendingGroupCreate, pendingGroupCreateHref, readPendingGroupCreate } from "../pendingGroupCreate";
const binding = { salonId: "11111111-1111-4111-8111-111111111111", idempotencyKey: "21111111-1111-4111-8111-111111111111", pricingFingerprint: "a".repeat(64) };
function storage(): Storage { const map = new Map<string,string>(); return { get length() { return map.size; }, key: n => [...map.keys()][n] ?? null, clear: () => map.clear(), getItem: k => map.get(k) ?? null, setItem: (k,v) => {map.set(k,v);}, removeItem: k => {map.delete(k);} }; }
afterEach(() => vi.useRealTimers());
describe("group create delivery authority", () => {
  it("round trips only strict internal bindings", () => {
    expect(parsePendingGroupCreate(pendingGroupCreateHref(binding)!.split('/booking/recover-group')[1])).toEqual(binding);
    expect(parsePendingGroupCreate('#group=invalid')).toBeNull();
    expect(pendingGroupCreateHref({...binding, salonId: 'https://evil.test'})).toBeNull();
  });
  it.each([502,503])("keeps authority after empty %s and blocks a changed second intent", async status => {
    const s=storage(), f=vi.fn().mockResolvedValue(new Response(null,{status}));
    expect(await dispatchGroupCreate(binding,{cardSourceId:'SECRET',phone:'CONTACT'},s,f)).toMatchObject({status:'unknown'});
    expect(s.getItem(s.key(0)!)).toBe(pendingGroupCreateHref(binding));
    expect(s.getItem(s.key(0)!)).not.toMatch(/SECRET|CONTACT/);
    expect(await dispatchGroupCreate({...binding,idempotencyKey:'31111111-1111-4111-8111-111111111111'},{},s,f)).toMatchObject({status:'unknown',recoveryHref:pendingGroupCreateHref(binding)});
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("persists before dispatch and survives transport failure/reload",async()=>{
    const s=storage(),f=vi.fn(async()=>{expect(readPendingGroupCreate(s,binding.salonId)).toBeTruthy();throw Error('lost');});
    expect(await dispatchGroupCreate(binding,{},s,f)).toMatchObject({status:'unknown'});
    expect(readPendingGroupCreate(s,binding.salonId)).toBe(pendingGroupCreateHref(binding));
    expect(readPendingGroupCreate(s,'31111111-1111-4111-8111-111111111111')).toBeNull();
  });
  it.each(['write','readback'])('does not dispatch if storage %s fails',async kind=>{
    const s=storage(),f=vi.fn();
    if(kind==='write')s.setItem=()=>{throw Error('blocked');};else s.setItem=()=>{};
    expect(await dispatchGroupCreate(binding,{},s,f)).toEqual({status:'storage_unavailable'});expect(f).not.toHaveBeenCalled();
  });
  it.each(['otp_required','pricing_changed','slot_conflict'])('releases known precommit rejection %s',async code=>{
    const s=storage(),f=vi.fn().mockResolvedValue(Response.json({ok:false,code},{status:409}));
    expect(await dispatchGroupCreate(binding,{},s,f)).toMatchObject({status:'response'});expect(s.length).toBe(0);
  });
  it.each(['idempotency_conflict','server_error'])('does not release ambiguous %s',async code=>{
    const s=storage(),f=vi.fn().mockResolvedValue(Response.json({ok:false,code},{status:409}));
    expect(await dispatchGroupCreate(binding,{},s,f)).toMatchObject({status:'unknown'});expect(s.length).toBe(1);
  });
  it('keeps malformed success pending',async()=>{
    const s=storage();expect(await dispatchGroupCreate(binding,{},s,vi.fn().mockResolvedValue(new Response('not-json')))).toMatchObject({status:'unknown'});expect(s.length).toBe(1);
  });
  it('requires canonical caller validation before clearing success, and cannot clear another intent',async()=>{
    const s=storage();await dispatchGroupCreate(binding,{},s,vi.fn().mockResolvedValue(Response.json({ok:true})));
    clearPendingGroupCreate(s,{...binding,pricingFingerprint:'b'.repeat(64)});expect(s.length).toBe(1);
    clearPendingGroupCreate(s,binding);expect(s.length).toBe(0);
  });
  it('bounds a transport that ignores abort without retrying',async()=>{
    vi.useFakeTimers();const s=storage(),f=vi.fn(()=>new Promise<Response>(()=>{}));const promise=dispatchGroupCreate(binding,{},s,f);
    await vi.advanceTimersByTimeAsync(12000);expect(await promise).toMatchObject({status:'unknown'});expect(f).toHaveBeenCalledTimes(1);expect(s.length).toBe(1);
  });
});

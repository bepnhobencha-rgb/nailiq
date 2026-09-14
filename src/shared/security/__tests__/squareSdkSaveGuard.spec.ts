import { describe, it, expect, vi } from "vitest";
import { createSdkSaveGuard } from "../../../../scripts/qa-square-sdk-guard";
const source = "cnon:synthetic_sdk_token_1234567890";
const ref = "nq-card:11111111-1111-4111-8111-111111111111";
function setup() { const nativeFetch = vi.fn(async () => Response.json({ ok:true })); const verifyOperation = vi.fn(async () => true);
 return {nativeFetch, verifyOperation, guard:createSdkSaveGuard({ sourceToken:source,accessToken:"synthetic-secret",syntheticEmail:"synthetic-qa@example.com",nativeFetch,verifyOperation })}; }
function card(sourceId=source, reference=ref) {return {method:"POST",headers:{Authorization:"Bearer synthetic-secret"},body:JSON.stringify({source_id:sourceId,idempotency_key:"qa",card:{customer_id:"synthetic",reference_id:reference}})};}
describe("SDK-only save transport",()=>{
 it("passes the exact SDK body unchanged once",async()=>{const s=setup();const req=card();await s.guard.fetch("https://connect.squareupsandbox.com/v2/cards",req);expect(await (s.nativeFetch.mock.calls[0] as unknown as [Request])[0].text()).toBe(req.body);expect(s.verifyOperation).toHaveBeenCalledWith(ref.slice(8));await expect(s.guard.fetch("https://connect.squareupsandbox.com/v2/cards",req)).rejects.toThrow();expect(s.nativeFetch).toHaveBeenCalledTimes(1)});
 it.each(["https://connect.squareup.com/v2/cards","https://fshmobzyjhmtvndobwsy.supabase.co/rest/v1/bookings","https://connect.squareupsandbox.com/v2/payments","https://connect.squareupsandbox.com/v2/refunds"])("denies %s",async url=>{const s=setup();await expect(s.guard.fetch(url,card())).rejects.toThrow();expect(s.nativeFetch).not.toHaveBeenCalled()});
 it.each(["cnon:card-nonce-ok","cnon:other_sdk_token_1234567890"])("rejects substituted token %s",async token=>{const s=setup();await expect(s.guard.fetch("https://connect.squareupsandbox.com/v2/cards",card(token))).rejects.toThrow();expect(s.nativeFetch).not.toHaveBeenCalled()});
 it("denies foreign operation",async()=>{const s=setup();s.verifyOperation.mockResolvedValue(false);await expect(s.guard.fetch("https://connect.squareupsandbox.com/v2/cards",card())).rejects.toThrow();expect(s.nativeFetch).not.toHaveBeenCalled()});
 it("denies foreign credentials",async()=>{const s=setup();await expect(s.guard.fetch("https://connect.squareupsandbox.com/v2/cards",{...card(),headers:{Authorization:"Bearer other"}})).rejects.toThrow();expect(s.nativeFetch).not.toHaveBeenCalled()});
 it("rejects fixed nonce at construction",()=>{expect(()=>createSdkSaveGuard({sourceToken:"cnon:card-nonce-ok",accessToken:"x",syntheticEmail:"synthetic-qa@example.com",nativeFetch:fetch,verifyOperation:async()=>true})).toThrow()});
});

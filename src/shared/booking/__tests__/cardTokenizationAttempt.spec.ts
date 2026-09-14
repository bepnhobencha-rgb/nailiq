import {describe,it,expect,vi} from "vitest";
import {createCardTokenizationAttempt} from "../cardTokenizationAttempt";
function deferred<T>() { let resolve!:(x:T)=>void;let reject!:(e:Error)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject}; }
describe("card tokenization lifetime",()=>{
 it("allows one pending SDK call and gives no result to a duplicate caller",async()=>{
  const g=createCardTokenizationAttempt();g.update("quote-a");const d=deferred<string>();const sdk=vi.fn(()=>d.promise);
  const first=g.run("quote-a",sdk);expect(await g.run("quote-a",sdk)).toBeNull();expect(sdk).toHaveBeenCalledOnce();d.resolve("synthetic");expect(await first).toBe("synthetic");
 });
 it.each(["changed quote","revoked consent","changed customer","unmounted"])("discards a successful response after %s",async reason=>{
  const g=createCardTokenizationAttempt();g.update("a");const d=deferred<string>();const first=g.run("a",()=>d.promise);g.update(reason==="unmounted"||reason==="revoked consent"?null:"b");d.resolve("synthetic");expect(await first).toBeNull();
 });
 it("cannot revive an old result by changing back to the original quote",async()=>{
  const g=createCardTokenizationAttempt();g.update("a");const d=deferred<string>();const first=g.run("a",()=>d.promise);g.update("b");g.update("a");d.resolve("synthetic");expect(await first).toBeNull();
 });
 it("keeps SDK calls serialized after invalidation, then permits a fresh attempt",async()=>{
  const g=createCardTokenizationAttempt();g.update("a");const d=deferred<string>();const first=g.run("a",()=>d.promise);g.update("b");const sdk=vi.fn(async()=>"new");expect(await g.run("b",sdk)).toBeNull();expect(sdk).not.toHaveBeenCalled();d.resolve("old");expect(await first).toBeNull();expect(await g.run("b",sdk)).toBe("new");
 });
 it("preserves a current error and unlocks for retry",async()=>{
  const g=createCardTokenizationAttempt();g.update("a");await expect(g.run("a",async()=>{throw Error("synthetic timeout");})).rejects.toThrow("synthetic timeout");expect(await g.run("a",async()=>"fresh")).toBe("fresh");
 });
 it("discards an obsolete failure instead of changing the new form",async()=>{
  const g=createCardTokenizationAttempt();g.update("a");const d=deferred<string>();const first=g.run("a",()=>d.promise);g.update("b");d.reject(Error("obsolete"));expect(await first).toBeNull();
 });
 it("never invokes SDK for missing consent or stale event handlers",async()=>{
  const g=createCardTokenizationAttempt();const sdk=vi.fn(async()=>"unexpected");expect(await g.run(null,sdk)).toBeNull();g.update("b");expect(await g.run("a",sdk)).toBeNull();expect(sdk).not.toHaveBeenCalled();
 });
 it("survives effect cleanup and setup without reviving a pending result",async()=>{
  const g=createCardTokenizationAttempt();g.update("a");const d=deferred<string>();const first=g.run("a",()=>d.promise);g.update(null);g.update("a");d.resolve("old");expect(await first).toBeNull();expect(await g.run("a",async()=>"fresh")).toBe("fresh");
 });
});

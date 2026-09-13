import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { readSquareCardStateById, readSquareCardById, type SquareConfig } from "../client";
const cfg: SquareConfig={salonId:"11111111-1111-4111-8111-111111111111",merchantId:"merchant_qa",locationId:"location_qa",
 accessToken:"synthetic",applicationId:"sandbox-app",environment:"sandbox",currency:"CAD",
 sync:{pullCreate:false,pullUpdate:false,pullCancel:false,pushCreate:false,pushUpdate:false,pushCancel:false}};
const card={id:"ccof:synthetic",customer_id:"customer_qa",merchant_id:"merchant_qa",enabled:false,card_brand:"VISA",last_4:"1111"};
function transport(value:unknown){const mock=vi.fn(async(url:string,init:RequestInit)=>{
 expect(url).toBe("https://connect.squareupsandbox.com/v2/cards/ccof%3Asynthetic");expect(init.method).toBe("GET");
 return new Response(JSON.stringify({card:value}),{status:200});});vi.stubGlobal("fetch",mock);return mock;}
afterEach(()=>vi.unstubAllGlobals());
describe("Square recovery read transport",()=>{
 it("reads a disabled card with one GET and no mutation",async()=>{
  const f=transport(card);expect(await readSquareCardStateById(cfg,card.id,card.customer_id)).toMatchObject({enabled:false,cardId:card.id});expect(f).toHaveBeenCalledTimes(1);
 });
 it("existing active-card reader continues to reject disabled cards",async()=>{
  transport(card);await expect(readSquareCardById(cfg,card.id,card.customer_id)).rejects.toThrow();
 });
 it("active-card reader continues to accept an active valid card",async()=>{
  transport({...card,enabled:true});expect((await readSquareCardById(cfg,card.id,card.customer_id)).enabled).toBe(true);
 });
 it.each([{id:"ccof:other"},{customer_id:"other"},{merchant_id:"other"},{enabled:null},{last_4:null}])("rejects invalid bound read %j",async(change)=>{
  const f=transport({...card,...change});await expect(readSquareCardStateById(cfg,card.id,card.customer_id)).rejects.toThrow();expect(f).toHaveBeenCalledTimes(1);
 });
});

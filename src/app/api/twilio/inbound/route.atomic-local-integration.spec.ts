import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
// Only the provider credential lookup and Next background scheduler are fake.
// Signature validation, service-role client, HTTP RPC and PostgreSQL are real.
vi.mock("@/shared/lib/twilioSignature", async (original) => ({
  ...await original<typeof import("@/shared/lib/twilioSignature")>(),
  getTwilioAuthToken: async () => "synthetic-inbound-hmac-token",
}));
const background = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", async (original) => ({
  ...await original<typeof import("next/server")>(), after: background.after,
}));
import { POST } from "./route";

const enabled = process.env.NAILIQ_LOCAL_ATOMIC_INBOUND_INTEGRATION === "1";
const database = process.env.NAILIQ_LOCAL_INBOUND_DATABASE ?? "nailiq_inbound_atomic_20260930_b2";
const eligibilityBatch = ["nailiq_inbound_atomic_20260930_b14", "nailiq_inbound_atomic_20260930_b15", "nailiq_inbound_atomic_20260930_b16"].includes(database);
const resourceBatch = eligibilityBatch || ["nailiq_inbound_atomic_20260930_b12", "nailiq_inbound_atomic_20260930_b13"].includes(database);
const creationBatch = resourceBatch || database === "nailiq_inbound_atomic_20260930_b11";
const raceBatch = creationBatch || ["nailiq_inbound_atomic_20260930_b5", "nailiq_inbound_atomic_20260930_b6", "nailiq_inbound_atomic_20260930_b7"].includes(database);
const promotionBatch = raceBatch || ["nailiq_inbound_atomic_20260930_b3", "nailiq_inbound_atomic_20260930_b4"].includes(database);
const origin = "http://127.0.0.1:54442";
const inbound = "http://127.0.0.1:3117/api/twilio/inbound";
const account = `AC${"a".repeat(32)}`;
const from = "+16045550201", to = "+16045550999";
const salonA = "30260930-0000-4000-8000-000000000081";
const salonB = "30260930-0000-4000-8000-000000000082";
const serviceA = "30260930-0000-4000-8000-000000000083";
const staffA = "30260930-0000-4000-8000-000000000085";
const uuid = (n: number) => `30260930-0000-4000-8000-${String(n).padStart(12,"0")}`;

describe.skipIf(!enabled)("isolated signed inbound route through HTTP RPC and PostgreSQL", () => {
  let sequence = 0, outsideAttempts = 0, expectedBackground = 0;
  const sids = new Set<string>();
  function sql<T>(statement: string): T {
    if ((!raceBatch && !["nailiq_inbound_atomic_20260930_b2", "nailiq_inbound_atomic_20260930_b3", "nailiq_inbound_atomic_20260930_b4"].includes(database)) ||
        process.env.NEXT_PUBLIC_SUPABASE_URL !== origin || process.env.NAILIQ_LOCAL_INBOUND_DATABASE !== database ||
        process.env.SUPABASE_INTERNAL_URL || process.env.NAILIQ_DISPOSABLE_DB !== "1") throw Error("not_isolated_local");
    return JSON.parse(execFileSync("docker", ["--context","colima-nailiq-p0-503","exec",
      "supabase_db_nailiq-day5-20260924","psql","-U","postgres","-d",database,
      "-X","-q","-A","-t","-v","ON_ERROR_STOP=1","-c",statement],
    {encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
  }
  function execute(statement: string) { return sql(statement + "; SELECT 'true'::json"); }
  function sid() {
    const value = "SM" + createHash("sha256").update("isolated-inbound-" + ++sequence).digest("hex").slice(0,32);
    sids.add(value); return value;
  }
  function fields(messageSid: string, overrides: Record<string,string> = {}) {
    return { AccountSid:account, MessageSid:messageSid, From:from, To:to, Body:"NO", ...overrides };
  }
  function request(params: Record<string,string>, token = "synthetic-inbound-hmac-token") {
    const signature = createHmac("sha1",token).update(inbound + Object.keys(params).sort().map(k=>k+params[k]).join("")).digest("base64");
    return new NextRequest(inbound,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",
      "x-twilio-signature":signature,"x-forwarded-host":"127.0.0.1:3117","x-forwarded-proto":"http"},
    body:new URLSearchParams(params)});
  }
  function booking(n: number, phone = from, otherSalon = false) {
    expect(/^\+16045550[0-9]{3}$/u.test(phone)).toBe(true);
    execute("BEGIN; SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true) WHERE false; " +
      // A SELECT returning output would corrupt the inspector JSON protocol;
      // SET LOCAL config instead preserves normal DB permission context.
      "SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}'; " +
      "INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents) VALUES(" +
      `'${uuid(n)}','${otherSalon?salonB:salonA}','${otherSalon?uuid(84):serviceA}','${otherSalon?uuid(86):staffA}',` +
      `'Synthetic','${phone}',((now() AT TIME ZONE 'America/Vancouver')::date+${n}+time '12:00') AT TIME ZONE 'America/Vancouver',` +
      `(((now() AT TIME ZONE 'America/Vancouver')::date+${n}+time '12:00') AT TIME ZONE 'America/Vancouver')+interval '30 minutes','confirmed',2500); COMMIT`);
    return uuid(n);
  }
  function state(id: string) {
    expect(/^30260930-0000-4000-8000-[0-9]{12}$/u.test(id)).toBe(true);
    return sql<string>(`SELECT to_json(status) FROM public.bookings WHERE id='${id}'`);
  }
  function receipt(messageSid: string) {
    expect(sids.has(messageSid)).toBe(true);
    return sql<Record<string,unknown> | null>("SELECT coalesce((SELECT row_to_json(r) FROM (SELECT result_json,created_at,booking_id,salon_id,request_fingerprint " +
      `FROM public.sms_inbound_booking_receipts WHERE account_sid='${account}' AND message_sid='${messageSid}') r),'null'::json)`);
  }
  function waiter(n: number, bookingId: string, requestedStaff?: string) {
    expect(/^30260930-0000-4000-8000-[0-9]{12}$/u.test(bookingId)).toBe(true);
    if(requestedStaff) expect(/^30260930-0000-4000-8000-[0-9]{12}$/u.test(requestedStaff)).toBe(true);
    execute(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}'; ` +
      `INSERT INTO public.booking_waitlist_entries(id,salon_id,service_id,staff_id,booking_date,preferred_slot_label,client_name,client_phone,client_email,source) ` +
      `SELECT '${uuid(n)}',salon_id,service_id,${requestedStaff?`'${requestedStaff}'::uuid`:"NULL::uuid"},(start_time_utc AT TIME ZONE 'America/Vancouver')::date,` +
      `'12:00 PM','Synthetic Waiter','+16045550301','waiter@example.invalid','slot_unavailable' FROM public.bookings WHERE id='${bookingId}'; COMMIT`);
    return uuid(n);
  }
  function promotionState(bookingId: string, entryId: string) {
    expect(/^30260930-0000-4000-8000-[0-9]{12}$/u.test(bookingId)).toBe(true);
    expect(/^30260930-0000-4000-8000-[0-9]{12}$/u.test(entryId)).toBe(true);
    return sql<Record<string, unknown>>(`SELECT json_build_object('entry',(SELECT row_to_json(w) FROM ` +
      `(SELECT status,offered_staff_id,offered_start_utc,offered_end_utc,claimed_at,booked_booking_id FROM public.booking_waitlist_entries WHERE id='${entryId}') w),` +
      `'promotion_count',(SELECT count(*)::int FROM public.waitlist_offer_promotion_receipts WHERE source_booking_id='${bookingId}'),` +
      `'capability_count',(SELECT count(*)::int FROM public.waitlist_claim_capabilities WHERE waitlist_entry_id='${entryId}'),` +
      `'outbox',(SELECT coalesce(json_agg(row_to_json(o) ORDER BY o.channel),'[]'::json) FROM ` +
      `(SELECT channel,status,attempt_count,provider_receipt,claim_capability_id,offer_epoch FROM public.waitlist_offer_delivery_outbox WHERE waitlist_entry_id='${entryId}') o))`);
  }
  function sequenceBooking(n: number, phone: string) {
    expect(resourceBatch).toBe(true);
    expect(/^\+16045550[0-9]{3}$/u.test(phone)).toBe(true);
    // Reuse the persisted sequence contract, retaining all real constraints and
    // triggers. Distinct resources allow prep/buffer overlap between lines.
    execute(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}'; ` +
      `INSERT INTO public.bookings(id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,` +
      `start_time_utc,end_time_utc,status,price_cents,original_price_cents,subtotal_cents,schedule_model,sequence_version) ` +
      `VALUES('${uuid(n)}','${uuid(90)}','${uuid(91)}','${uuid(92)}','${uuid(94)}','Synthetic sequence','${phone}',` +
      `((now() AT TIME ZONE 'America/Vancouver')::date+${n}+time '12:00') AT TIME ZONE 'America/Vancouver',` +
      `((now() AT TIME ZONE 'America/Vancouver')::date+${n}+time '13:00') AT TIME ZONE 'America/Vancouver',` +
      `'confirmed',5000,5000,5000,'segments_v1',1); ` +
      `INSERT INTO public.booking_service_segments(booking_id,salon_id,position,line_id,service_id,staff_id,resource_id,` +
      `customer_start_utc,customer_end_utc,occupied_start_utc,occupied_end_utc,prep_minutes,service_duration_minutes,` +
      `trailing_buffer_minutes,service_name,staff_name,original_service_price_cents,service_pre_voucher_cents,` +
      `service_price_cents,subtotal_cents,total_cents,reservation_status) ` +
      `SELECT b.id,b.salon_id,line.position,CASE line.position WHEN 0 THEN '${uuid(n+1000)}'::uuid ELSE '${uuid(n+1001)}'::uuid END,b.service_id,line.staff_id,line.resource_id,` +
      `b.start_time_utc+make_interval(mins=>line.position*30),b.start_time_utc+make_interval(mins=>(line.position+1)*30),` +
      `b.start_time_utc+make_interval(mins=>line.position*30-5),b.start_time_utc+make_interval(mins=>(line.position+1)*30+5),` +
      `5,30,5,'Synthetic service','Synthetic staff',2500,2500,2500,2500,2500,b.status ` +
      `FROM public.bookings b CROSS JOIN (VALUES(0,'${uuid(92)}'::uuid,'${uuid(94)}'::uuid),` +
      `(1,'${uuid(93)}'::uuid,'${uuid(95)}'::uuid)) AS line(position,staff_id,resource_id) WHERE b.id='${uuid(n)}'; COMMIT`);
    return uuid(n);
  }
  function segmentState(id: string) {
    expect(/^30260930-0000-4000-8000-[0-9]{12}$/u.test(id)).toBe(true);
    return sql<Record<string,unknown>>(`SELECT json_build_object('parent',b.status,'segments',` +
      `(SELECT json_agg(json_build_object('position',s.position,'status',s.reservation_status,'staff',s.staff_id,'resource',s.resource_id) ORDER BY s.position) ` +
      `FROM public.booking_service_segments s WHERE s.booking_id=b.id),'capacity',` +
      `(SELECT coalesce(json_agg(json_build_object('staff',c.staff_id,'resource',c.resource_id,'start',c.start_time_utc,'end',c.end_time_utc) ` +
      `ORDER BY c.resource_id,c.start_time_utc,c.end_time_utc),'[]'::json) FROM public.public_booking_capacity_for_range(` +
      `b.salon_id,b.start_time_utc-interval '5 minutes',b.end_time_utc+interval '5 minutes') c)) FROM public.bookings b WHERE b.id='${id}'`);
  }
  async function nonSmsRace(id: string, mutation: string, params: Record<string,string>) {
    expect(/^30260930-0000-4000-8000-[0-9]{12}$/u.test(id)).toBe(true);
    const writer=spawn("docker",["--context","colima-nailiq-p0-503","exec","supabase_db_nailiq-day5-20260924",
      "psql","-U","postgres","-d",database,"-X","-q","-A","-t","-v","ON_ERROR_STOP=1","-c",
      `BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}'; ${mutation}; SELECT pg_sleep(4); COMMIT;`],{stdio:"pipe"});
    const done=new Promise<number|null>((resolve,reject)=>{writer.once("error",reject);writer.once("exit",resolve);});
    let holderObserved=false;
    for(let i=0;i<40;i++){
      if(sql<boolean>(`SELECT to_json(EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%${id}%' AND wait_event='PgSleep'))`)){
        holderObserved=true;break;
      }
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    if(!holderObserved){await done;throw Error("non_sms_writer_not_proven");}
    const pending=POST(request(params));
    let overlapping=false;
    for(let i=0;i<40;i++){
      if(sql<number>("SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event IN ('advisory','transactionid') AND query LIKE '%cancel_booking_from_signed_sms%'")>=1){
        overlapping=true;break;
      }
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    const writerExit=await done,first=await pending;
    // Always exercise the identical SID retry before asserting: a first
    // 503 alone hides the destructive retargeting regression.
    const replay=await POST(request(params));
    expect(overlapping).toBe(true);expect(writerExit).toBe(0);
    return {first,replay};
  }
  beforeAll(() => {
    expect(process.env.NAILIQ_ATOMIC_INBOUND_SMS_CANCEL).toBe("true");
    const ownership = sql<string>("SELECT to_json(shobj_description(oid,'pg_database')) FROM pg_database WHERE datname=current_database()");
    expect(ownership).toBe("Owned synthetic P1-01 local test 20260930; no production or customer data");
    const counts=sql<Record<string,number>>("SELECT json_build_object('salons',(select count(*) from public.salons),'users',(select count(*) from auth.users),'bookings',(select count(*) from public.bookings),'receipts',(select count(*) from public.sms_inbound_booking_receipts))");
    expect(Object.values(counts).every(n=>n===0)).toBe(true);
    execute("INSERT INTO public.platform_settings(id,twilio_account_sid,twilio_phone_number) VALUES('platform','"+account+"','"+to+"'); "+
      "INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('e2e-atomic-http','Synthetic','Synthetic'); "+
      `INSERT INTO public.salons(id,slug,name,phone,timezone,is_beta) VALUES('${salonA}','e2e-atomic-http-a','Synthetic A','+16045550981','America/Vancouver',true),('${salonB}','e2e-atomic-http-b','Synthetic B','+16045550982','America/Vancouver',true); `+
      `INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category) VALUES('${serviceA}','${salonA}','Synthetic',2500,30,'e2e-atomic-http'),('${uuid(84)}','${salonB}','Synthetic',2500,30,'e2e-atomic-http'); `+
      `INSERT INTO public.staff(id,salon_id,name,status) VALUES('${staffA}','${salonA}','Synthetic A','active'),('${uuid(86)}','${salonB}','Synthetic B','active')`);
    execute(`UPDATE public.salons SET profile_complete=true,resources_enabled=false,opening_hours=` +
      `(SELECT jsonb_object_agg(day,jsonb_build_object('open','00:00','close','23:59','closed',false)) ` +
      `FROM unnest(ARRAY['sun','mon','tue','wed','thu','fri','sat']) AS day) WHERE id IN ('${salonA}','${salonB}')`);
    if(resourceBatch) execute(`BEGIN; INSERT INTO public.salons(id,slug,name,phone,timezone,is_beta,profile_complete,resources_enabled,opening_hours) ` +
      `SELECT '${uuid(90)}','e2e-atomic-resource','Synthetic resources','+16045550983',timezone,true,true,true,opening_hours FROM public.salons WHERE id='${salonA}'; ` +
      `INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,prep_minutes,buffer_minutes,category,resource_requirement_mode,required_resource_kinds) ` +
      `VALUES('${uuid(91)}','${uuid(90)}','Synthetic resource service',2500,30,5,5,'e2e-atomic-http','specific',ARRAY['bed']); ` +
      `INSERT INTO public.staff(id,salon_id,name,status) VALUES('${uuid(92)}','${uuid(90)}','Synthetic resource A','active'),` +
      `('${uuid(93)}','${uuid(90)}','Synthetic resource B','active'),('${uuid(96)}','${uuid(90)}','Synthetic resource C','active'); ` +
      `INSERT INTO public.salon_resources(id,salon_id,name,kind) VALUES('${uuid(94)}','${uuid(90)}','Synthetic bed A','bed'),` +
      `('${uuid(95)}','${uuid(90)}','Synthetic bed B','bed'),('${uuid(97)}','${uuid(90)}','Synthetic bed C','bed'); COMMIT`);
    const original=globalThis.fetch;
    vi.stubGlobal("fetch",(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=new URL(input instanceof Request?input.url:String(input));
      if(url.origin!==origin){outsideAttempts++;throw Error("non_local_transport_forbidden");}
      return original(input,init);
    });
  });
  afterAll(()=>{
    expect(outsideAttempts).toBe(0);
    expect(background.after).toHaveBeenCalledTimes(expectedBackground);
    vi.unstubAllGlobals();
  });
  it("commits a genuinely signed cancellation and replays its original receipt without retargeting",async()=>{
    const first=booking(100),second=booking(101),messageSid=sid();
    const response=await POST(request(fields(messageSid)));
    expect(response.status).toBe(200);expect(await response.text()).toContain("Your appointment is cancelled");
    expect(state(first)).toBe("cancelled"); expect(state(second)).toBe("confirmed");
    const original=receipt(messageSid);expect(original?.booking_id).toBe(first);
    expect((await POST(request(fields(messageSid)))).status).toBe(200);
    expect(receipt(messageSid)).toEqual(original);expect(state(second)).toBe("confirmed");
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_events WHERE booking_id='${first}' AND event_type='booking_cancelled'`)).toBe(1);
  });
  it("rejects a wrong real HMAC without a command receipt or status change",async()=>{
    const id=booking(110,"+16045550202"),messageSid=sid();
    expect((await POST(request(fields(messageSid,{From:"+16045550202"}),"wrong-synthetic-token"))).status).toBe(403);
    expect(receipt(messageSid)).toBeNull();expect(state(id)).toBe("confirmed");
  });
  it("rejects signed body tampering under an existing SID",async()=>{
    const id=booking(120,"+16045550203"),next=booking(121,"+16045550203"),messageSid=sid();
    expect((await POST(request(fields(messageSid,{From:"+16045550203"})))).status).toBe(200);
    const original=receipt(messageSid);
    expect((await POST(request(fields(messageSid,{From:"+16045550203",Body:"HỦY"})))).status).toBe(503);
    expect(state(id)).toBe("cancelled");expect(state(next)).toBe("confirmed");expect(receipt(messageSid)).toEqual(original);
  });
  it("does not pick a salon when two salons have the same signed caller",async()=>{
    const first=booking(130,"+16045550204"),other=booking(131,"+16045550204",true),messageSid=sid();
    const response=await POST(request(fields(messageSid,{From:"+16045550204"})));
    expect(response.status).toBe(200);expect(await response.text()).toContain("Nothing was cancelled");
    expect(state(first)).toBe("confirmed");expect(state(other)).toBe("confirmed");
    expect(receipt(messageSid)?.result_json).toMatchObject({code:"ambiguous_salon"});
  });
  it("keeps not-found durable after a new appointment appears",async()=>{
    const messageSid=sid(),params=fields(messageSid,{From:"+16045550205"});
    expect((await POST(request(params))).status).toBe(200);
    const original=receipt(messageSid),id=booking(140,"+16045550205");
    expect((await POST(request(params))).status).toBe(200);expect(state(id)).toBe("confirmed");expect(receipt(messageSid)).toEqual(original);
  });
  it("serializes two real HTTP commands while both wait on the same PostgreSQL lock",async()=>{
    const first=booking(150,"+16045550206"),next=booking(151,"+16045550206"),messageSid=sid();
    const lockKey=`inbound-sms:${account}:${messageSid}`;
    const hold=spawn("docker",["--context","colima-nailiq-p0-503","exec","supabase_db_nailiq-day5-20260924",
      "psql","-U","postgres","-d",database,"-X","-A","-t","-v","ON_ERROR_STOP=1","-c",
      `BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('${lockKey}',0)); SELECT pg_sleep(4); COMMIT;`],{stdio:"pipe"});
    const done=new Promise<number|null>(resolve=>hold.on("exit",resolve));
    for(let i=0;i<40;i++){
      const locked=sql<boolean>(`SELECT to_json(EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%${lockKey}%' AND wait_event='PgSleep'))`);
      if(locked)break;if(i===39)throw Error("lock_holder_not_proven");await new Promise(resolve=>setTimeout(resolve,25));
    }
    const params=fields(messageSid,{From:"+16045550206"});
    const pending=Promise.all([POST(request(params)),POST(request(params))]);
    let overlapping=false;
    for(let i=0;i<40;i++){
      const waiters=sql<number>("SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND query LIKE '%cancel_booking_from_signed_sms%'");
      if(waiters>=2){overlapping=true;break;}await new Promise(resolve=>setTimeout(resolve,25));
    }
    expect(overlapping).toBe(true);expect(await done).toBe(0);
    expect((await pending).map(r=>r.status)).toEqual([200,200]);
    expect(state(first)).toBe("cancelled");expect(state(next)).toBe("confirmed");
    expect(sql<number>(`SELECT count(*)::int FROM public.sms_inbound_booking_receipts WHERE message_sid='${messageSid}'`)).toBe(1);
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_notifications WHERE twilio_message_sid='${messageSid}'`)).toBe(1);
  },15000);
  it("enforces browser-role RPC ACL across the real Data API",async()=>{
    for(const role of ["anon","authenticated"]){
      const token=process.env[role==="anon"?"E2E_INBOUND_ANON_TOKEN":"E2E_INBOUND_AUTHENTICATED_TOKEN"];
      expect(token).toBeTruthy();
      const response=await fetch(origin+"/rest/v1/rpc/cancel_booking_from_signed_sms",{method:"POST",headers:{"content-type":"application/json",Authorization:`Bearer ${token}`},
        body:JSON.stringify({p_account_sid:account,p_message_sid:sid(),p_from_phone:from,p_to_phone:to,p_body_sha256:"a".repeat(64)})});
      expect([401,403]).toContain(response.status);expect((await response.json()).code).toBe("42501");
    }
  });
  it("does not expose the private ledger even to direct service-role reads",async()=>{
    const response=await fetch(origin+"/rest/v1/sms_inbound_booking_receipts?select=message_sid",{headers:{Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`}});
    expect(response.status).toBe(403);expect((await response.json()).code).toBe("42501");
  });
  it.skipIf(!promotionBatch)("commits one exact Waitlist offer and keeps the capability stable across signed replay",async()=>{
    const id=booking(160,"+16045550207"),next=booking(161,"+16045550207");
    const entry=waiter(260,id),messageSid=sid(),params=fields(messageSid,{From:"+16045550207"});
    const before=promotionState(id,entry);
    expect(before).toMatchObject({entry:{status:"waiting"},promotion_count:0,capability_count:0,outbox:[]});
    const response=await POST(request(params));
    expect(response.status).toBe(200);expect(await response.text()).toContain("Your appointment is cancelled");
    expectedBackground++;
    const original=receipt(messageSid),result=original?.result_json as Record<string,unknown>;
    expect(result).toMatchObject({code:"applied",booking_id:id,salon_id:salonA,promoted_waitlist:{ok:true,code:"promoted",waitlist_entry_id:entry,offer_epoch:1}});
    const promotion=result.promoted_waitlist as Record<string,unknown>;
    expect(promotion.claim_capability_token).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/u));
    const committed=promotionState(id,entry);
    expect(committed).toMatchObject({entry:{status:"notified",offered_staff_id:staffA,claimed_at:null,booked_booking_id:null},promotion_count:1,capability_count:1});
    expect(committed.outbox).toEqual([
      {channel:"email",status:"pending",attempt_count:0,provider_receipt:null,claim_capability_id:promotion.claim_capability_token,offer_epoch:1},
      {channel:"sms",status:"pending",attempt_count:0,provider_receipt:null,claim_capability_id:promotion.claim_capability_token,offer_epoch:1},
    ]);
    expect((await POST(request(params))).status).toBe(200);expectedBackground++;
    expect(receipt(messageSid)).toEqual(original);expect(promotionState(id,entry)).toEqual(committed);
    expect(state(id)).toBe("cancelled");expect(state(next)).toBe("confirmed");
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_notifications WHERE twilio_message_sid='${messageSid}'`)).toBe(1);
    // The scheduler is only recorded, never executed: pending != delivered.
  });
  it.skipIf(!promotionBatch)("rolls back booking, promotion and audit on a late SQL failure, then safely retries the same signed SID",async()=>{
    const id=booking(170,"+16045550208"),next=booking(171,"+16045550208");
    const entry=waiter(270,id),messageSid=sid(),params=fields(messageSid,{From:"+16045550208"});
    const before=promotionState(id,entry),backgroundBefore=background.after.mock.calls.length;
    // Additive fault fixture in a private schema of the owned local clone.
    // No production function is replaced and no existing grants are loosened.
    execute(`CREATE SCHEMA qa_inbound_fault; REVOKE ALL ON SCHEMA qa_inbound_fault FROM PUBLIC,anon,authenticated,service_role; ` +
      `CREATE TABLE qa_inbound_fault.switch(message_sid text PRIMARY KEY,enabled boolean NOT NULL); ` +
      `INSERT INTO qa_inbound_fault.switch VALUES('${messageSid}',true); ` +
      `CREATE FUNCTION qa_inbound_fault.fail_log() RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $fault$ BEGIN ` +
      `IF EXISTS(SELECT 1 FROM qa_inbound_fault.switch WHERE message_sid=NEW.twilio_message_sid AND enabled) THEN ` +
      `RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Synthetic late transaction fault'; END IF; RETURN NEW; END; $fault$; ` +
      `REVOKE ALL ON TABLE qa_inbound_fault.switch FROM PUBLIC,anon,authenticated,service_role; ` +
      `REVOKE ALL ON FUNCTION qa_inbound_fault.fail_log() FROM PUBLIC,anon,authenticated,service_role; ` +
      `CREATE TRIGGER qa_inbound_late_fault BEFORE INSERT ON public.booking_notifications FOR EACH ROW EXECUTE FUNCTION qa_inbound_fault.fail_log()`);
    const failed=await POST(request(params));
    expect(failed.status).toBe(503);expect(await failed.text()).not.toContain("cancelled");
    expect(receipt(messageSid)).toBeNull();expect(state(id)).toBe("confirmed");expect(state(next)).toBe("confirmed");
    expect(promotionState(id,entry)).toEqual(before);expect(background.after).toHaveBeenCalledTimes(backgroundBefore);
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_events WHERE booking_id='${id}' AND event_type='booking_cancelled'`)).toBe(0);
    execute(`UPDATE qa_inbound_fault.switch SET enabled=false WHERE message_sid='${messageSid}'`);
    const retried=await POST(request(params));expect(retried.status).toBe(200);expectedBackground++;
    expect(state(id)).toBe("cancelled");expect(state(next)).toBe("confirmed");
    const original=receipt(messageSid),committed=promotionState(id,entry);
    expect(committed).toMatchObject({entry:{status:"notified"},promotion_count:1,capability_count:1});
    expect((await POST(request(params))).status).toBe(200);expectedBackground++;
    expect(receipt(messageSid)).toEqual(original);expect(promotionState(id,entry)).toEqual(committed);
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_events WHERE booking_id='${id}' AND event_type='booking_cancelled'`)).toBe(1);
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_notifications WHERE twilio_message_sid='${messageSid}'`)).toBe(1);
  });
  it.skipIf(!raceBatch)("pins the original booking when a non-SMS cancellation wins, without cancelling the next appointment on retry",async()=>{
    const id=booking(180,"+16045550209"),next=booking(181,"+16045550209"),entry=waiter(280,id);
    const messageSid=sid(),params=fields(messageSid,{From:"+16045550209"});
    const {first,replay}=await nonSmsRace(id,`DO $writer$ BEGIN PERFORM public.cancel_booking_by_id_with_waitlist_offer('${id}'); END; $writer$`,params);
    expect(state(next)).toBe("confirmed");
    expect(first.status).toBe(200);expect(replay.status).toBe(200);
    expect(await first.text()).toContain("already cancelled");
    const original=receipt(messageSid);
    expect(original).toMatchObject({booking_id:id,salon_id:salonA,result_json:{code:"already_cancelled"}});
    expect((await POST(request(params))).status).toBe(200);expect(receipt(messageSid)).toEqual(original);
    expect(state(id)).toBe("cancelled");expect(state(next)).toBe("confirmed");
    expect(promotionState(id,entry)).toMatchObject({entry:{status:"notified"},promotion_count:1,capability_count:1});
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_events WHERE booking_id='${id}' AND event_type='booking_cancelled'`)).toBe(0);
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_notifications WHERE twilio_message_sid='${messageSid}'`)).toBe(0);
  },15000);
  it.skipIf(!raceBatch).each([
    {n:190,phone:"+16045550210",change:"start_time_utc=start_time_utc+interval '1 hour',end_time_utc=end_time_utc+interval '1 hour'",status:"confirmed"},
    {n:200,phone:"+16045550211",change:"client_phone='+16045550401'",status:"confirmed"},
    // The deployed schema represents service activity as in_progress;
    // arrived is a UI/domain concept, not a permitted DB status literal.
    // This models a competing server writer, not role/transition UI proof.
    {n:210,phone:"+16045550212",change:"status='in_progress',started_at=now()",status:"in_progress"},
    {n:220,phone:"+16045550213",change:"price_cents=2600",status:"confirmed"},
  ])("records booking_changed without cancelling a moved/changed appointment: $n",async({n,phone,change,status})=>{
    const id=booking(n,phone),next=booking(n+1,phone),messageSid=sid(),params=fields(messageSid,{From:phone});
    const {first,replay}=await nonSmsRace(id,`UPDATE public.bookings SET ${change} WHERE id='${id}'`,params);
    expect(first.status).toBe(200);expect(replay.status).toBe(200);
    expect(await first.text()).toContain("Nothing was cancelled by this reply");
    expect(state(id)).toBe(status);expect(state(next)).toBe("confirmed");
    const original=receipt(messageSid);
    expect(original).toMatchObject({booking_id:id,salon_id:salonA,result_json:{code:"booking_changed"}});
    expect((await POST(request(params))).status).toBe(200);expect(receipt(messageSid)).toEqual(original);
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_events WHERE booking_id='${id}' AND event_type='booking_cancelled'`)).toBe(0);
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_notifications WHERE twilio_message_sid='${messageSid}'`)).toBe(0);
  },15000);
  it.skipIf(!creationBatch)("rechecks a second salon committed while the selected booking promotion lock is held",async()=>{
    const phone="+16045550214",id=booking(240,phone),next=booking(241,phone),newId=uuid(242),messageSid=sid();
    const params=fields(messageSid,{From:phone});
    const mutation=`SELECT pg_advisory_xact_lock(hashtextextended('waitlist-booking-promotion:${id}',0)); `+
      `INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents) `+
      `SELECT '${newId}','${salonB}','${uuid(84)}','${uuid(86)}','Synthetic','${phone}',start_time_utc+interval '1 day',end_time_utc+interval '1 day','confirmed',2500 FROM public.bookings WHERE id='${id}'`;
    const {first,replay}=await nonSmsRace(id,mutation,params);
    expect(first.status).toBe(200);expect(replay.status).toBe(200);
    expect(await first.text()).toContain("more than one salon. Nothing was cancelled");
    expect([state(id),state(next),state(newId)]).toEqual(["confirmed","confirmed","confirmed"]);
    const original=receipt(messageSid);
    expect(original).toMatchObject({booking_id:null,salon_id:null,result_json:{code:"ambiguous_salon"}});
    // Resolving the ambiguity later must not make the old command select again.
    execute(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}'; UPDATE public.bookings SET status='cancelled' WHERE id='${newId}'; COMMIT`);
    const afterResolved=await POST(request(params));
    expect(afterResolved.status).toBe(200);expect(await afterResolved.text()).toContain("Nothing was cancelled");
    expect(receipt(messageSid)).toEqual(original);expect(state(id)).toBe("confirmed");expect(state(next)).toBe("confirmed");
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_events WHERE booking_id='${id}' AND event_type='booking_cancelled'`)).toBe(0);
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_notifications WHERE twilio_message_sid='${messageSid}'`)).toBe(0);
  },15000);
  it.skipIf(!creationBatch).each([
    {n:250,phone:"+16045550215",reminder:false},
    {n:260,phone:"+16045550216",reminder:true},
  ])("does not retarget a new earlier booking inserted during cancellation: reminder=$reminder",async({n,phone,reminder})=>{
    const id=booking(n,phone),next=booking(n+1,phone),newId=uuid(n+2),messageSid=sid();
    const params=fields(messageSid,{From:phone});
    const mutation=`SELECT pg_advisory_xact_lock(hashtextextended('waitlist-booking-promotion:${id}',0)); `+
      `INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents,reminder_24h_sent_at) `+
      `SELECT '${newId}',salon_id,service_id,staff_id,'Synthetic','${phone}',start_time_utc-interval '1 day',end_time_utc-interval '1 day','confirmed',2500,${reminder?"now()":"NULL::timestamptz"} FROM public.bookings WHERE id='${id}'`;
    const {first,replay}=await nonSmsRace(id,mutation,params);
    expect(first.status).toBe(200);expect(replay.status).toBe(200);
    expect(await first.text()).toContain("Your appointment is cancelled");
    expect([state(id),state(next),state(newId)]).toEqual(["cancelled","confirmed","confirmed"]);
    const original=receipt(messageSid);
    expect(original).toMatchObject({booking_id:id,salon_id:salonA,result_json:{code:"applied"}});
    expect((await POST(request(params))).status).toBe(200);expect(receipt(messageSid)).toEqual(original);
    expect(state(newId)).toBe("confirmed");
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_events WHERE booking_id='${id}' AND event_type='booking_cancelled'`)).toBe(1);
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_notifications WHERE twilio_message_sid='${messageSid}'`)).toBe(1);
  },15000);
  it.skipIf(!resourceBatch)("cancels every sequence line and frees both resources including prep/buffer without changing them on SID replay",async()=>{
    const id=sequenceBooking(350,"+16045550217"),messageSid=sid(),params=fields(messageSid,{From:"+16045550217"});
    const before=segmentState(id);
    expect(before).toMatchObject({parent:"confirmed",segments:[{position:0,status:"confirmed"},{position:1,status:"confirmed"}]});
    expect((before.capacity as unknown[]).length).toBeGreaterThanOrEqual(2);
    const response=await POST(request(params));
    expect(response.status).toBe(200);expect(await response.text()).toContain("Your appointment is cancelled");
    const committed=segmentState(id),original=receipt(messageSid);
    expect(committed).toMatchObject({parent:"cancelled",segments:[{position:0,status:"cancelled"},{position:1,status:"cancelled"}],capacity:[]});
    expect(original).toMatchObject({booking_id:id,salon_id:uuid(90),result_json:{code:"applied"}});
    expect((await POST(request(params))).status).toBe(200);
    expect(segmentState(id)).toEqual(committed);expect(receipt(messageSid)).toEqual(original);
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_events WHERE booking_id='${id}' AND event_type='booking_cancelled'`)).toBe(1);
    // A database write using each released staff/resource now succeeds. This
    // proves commit-time reuse, not only an empty availability read.
    execute(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}'; ` +
      `INSERT INTO public.bookings(id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents) ` +
      `SELECT CASE line.position WHEN 0 THEN '${uuid(3350)}'::uuid ELSE '${uuid(3351)}'::uuid END,b.salon_id,b.service_id,line.staff_id,line.resource_id,` +
      `'Synthetic reuse','+16045550417',b.start_time_utc+make_interval(mins=>line.position*30),` +
      `b.start_time_utc+make_interval(mins=>(line.position+1)*30),'confirmed',2500 FROM public.bookings b ` +
      `CROSS JOIN (VALUES(0,'${uuid(92)}'::uuid,'${uuid(94)}'::uuid),(1,'${uuid(93)}'::uuid,'${uuid(95)}'::uuid)) AS line(position,staff_id,resource_id) ` +
      `WHERE b.id='${id}'; COMMIT`);
    expect([state(uuid(3350)),state(uuid(3351))]).toEqual(["confirmed","confirmed"]);
    expect((await POST(request(params))).status).toBe(200);expect(receipt(messageSid)).toEqual(original);
    expect([state(uuid(3350)),state(uuid(3351))]).toEqual(["confirmed","confirmed"]);
  });
  it.skipIf(!resourceBatch)("restores all sequence lines, resources and Waitlist state after a late failure, then cancels exactly once on retry",async()=>{
    // Other staff/resources are intentionally free: only the customer's
    // explicit staff preference makes this a truthful unavailable slot.
    const id=sequenceBooking(360,"+16045550218"),entry=waiter(1360,id,uuid(92)),messageSid=sid();
    const params=fields(messageSid,{From:"+16045550218"}),before=segmentState(id),waitBefore=promotionState(id,entry);
    const backgroundBefore=background.after.mock.calls.length;
    execute(`INSERT INTO qa_inbound_fault.switch VALUES('${messageSid}',true)`);
    const failed=await POST(request(params));
    expect(failed.status).toBe(503);expect(await failed.text()).not.toContain("cancelled");
    expect(segmentState(id)).toEqual(before);expect(promotionState(id,entry)).toEqual(waitBefore);expect(receipt(messageSid)).toBeNull();
    expect(background.after).toHaveBeenCalledTimes(backgroundBefore);
    execute(`UPDATE qa_inbound_fault.switch SET enabled=false WHERE message_sid='${messageSid}'`);
    expect((await POST(request(params))).status).toBe(200);expectedBackground++;
    const committed=segmentState(id),offer=promotionState(id,entry),original=receipt(messageSid);
    expect(committed).toMatchObject({parent:"cancelled",segments:[{status:"cancelled"},{status:"cancelled"}],capacity:[]});
    expect(offer).toMatchObject({entry:{status:"notified"},promotion_count:1,capability_count:1});
    expect((await POST(request(params))).status).toBe(200);expectedBackground++;
    expect(segmentState(id)).toEqual(committed);expect(promotionState(id,entry)).toEqual(offer);expect(receipt(messageSid)).toEqual(original);
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_events WHERE booking_id='${id}' AND event_type='booking_cancelled'`)).toBe(1);
    expect(sql<number>(`SELECT count(*)::int FROM public.booking_notifications WHERE twilio_message_sid='${messageSid}'`)).toBe(1);
  });
  it.skipIf(!resourceBatch)("frees only the cancelled sequence resources while a different customer's resource stays occupied and rejects double-booking",async()=>{
    const id=sequenceBooking(370,"+16045550219"),other=uuid(1370),messageSid=sid(),params=fields(messageSid,{From:"+16045550219"});
    execute(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}'; ` +
      `INSERT INTO public.bookings(id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents) ` +
      `SELECT '${other}',salon_id,service_id,'${uuid(96)}','${uuid(97)}','Synthetic occupied','+16045550419',` +
      `start_time_utc,start_time_utc+interval '30 minutes','confirmed',2500 FROM public.bookings WHERE id='${id}'; COMMIT`);
    expect((await POST(request(params))).status).toBe(200);
    const committed=segmentState(id),original=receipt(messageSid);
    expect(committed).toMatchObject({parent:"cancelled",segments:[{status:"cancelled"},{status:"cancelled"}]});
    expect(committed.capacity).toEqual([expect.objectContaining({staff:uuid(96),resource:uuid(97)})]);
    expect(state(other)).toBe("confirmed");
    // Assert the actual exclusion backstop, not a client-side availability mock.
    const result=sql<{rejected:boolean}>(`DO $capacity$ BEGIN BEGIN ` +
      `INSERT INTO public.bookings(id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents) ` +
      `SELECT '${uuid(2370)}',salon_id,service_id,staff_id,resource_id,'Synthetic conflict','+16045550420',start_time_utc,end_time_utc,'confirmed',2500 ` +
      `FROM public.bookings WHERE id='${other}'; RAISE EXCEPTION 'Synthetic conflict unexpectedly committed'; ` +
      `EXCEPTION WHEN exclusion_violation THEN NULL; END; END; $capacity$; ` +
      `SELECT json_build_object('rejected',NOT EXISTS(SELECT 1 FROM public.bookings WHERE id='${uuid(2370)}'))`);
    expect(result.rejected).toBe(true);
    expect((await POST(request(params))).status).toBe(200);expect(segmentState(id)).toEqual(committed);expect(receipt(messageSid)).toEqual(original);
  });
  it.skipIf(!eligibilityBatch).each([
    {n:390,phone:"+16045550220",kind:"different_requested_staff"},
    {n:400,phone:"+16045550221",kind:"salon_closed_after_waitlist"},
    {n:410,phone:"+16045550222",kind:"insufficient_gap_after_catalog_change"},
    {n:420,phone:"+16045550223",kind:"availability_unverified"},
    {n:430,phone:"+16045550224",kind:"unsupported_addon_intent"},
    {n:440,phone:"+16045550225",kind:"different_preferred_time"},
    {n:450,phone:"+16045550226",kind:"prep_overlap_after_catalog_change"},
    {n:460,phone:"+16045550227",kind:"prep_before_staff_shift"},
  ])("does not mint an unsafe Waitlist offer after a valid cancellation: $kind",async({n,phone,kind})=>{
    const id=sequenceBooking(n,phone),other=uuid(n+3000),messageSid=sid();
    const requested=kind==="different_requested_staff"?uuid(96):uuid(92);
    if(kind==="different_requested_staff"||kind==="insufficient_gap_after_catalog_change"){
      const time=kind==="different_requested_staff"?"start_time_utc":"end_time_utc";
      const staff=kind==="different_requested_staff"?uuid(96):uuid(92);
      const resource=kind==="different_requested_staff"?uuid(97):uuid(94);
      execute(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}'; ` +
        `INSERT INTO public.bookings(id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents) ` +
        `SELECT '${other}',salon_id,service_id,'${staff}','${resource}','Synthetic conflict','+16045550421',` +
        `${time},${time}+interval '30 minutes','confirmed',2500 FROM public.bookings WHERE id='${id}'; COMMIT`);
    }
    // Both candidate preferences are genuinely unavailable at initial join.
    const entry=waiter(n+2000,id,requested),params=fields(messageSid,{From:phone});
    const date=sql<string>(`SELECT to_json((start_time_utc AT TIME ZONE 'America/Vancouver')::date::text) FROM public.bookings WHERE id='${id}'`);
    expect(/^\d{4}-\d{2}-\d{2}$/u.test(date)).toBe(true);
    if(kind==="salon_closed_after_waitlist")execute(`UPDATE public.salons SET booking_closed_dates=jsonb_build_array('${date}') WHERE id='${uuid(90)}'`);
    if(kind==="insufficient_gap_after_catalog_change")execute(`UPDATE public.services SET duration_minutes=90 WHERE id='${uuid(91)}'`);
    if(kind==="availability_unverified")execute(`UPDATE public.salons SET profile_complete=false WHERE id='${uuid(90)}'`);
    if(kind==="unsupported_addon_intent")execute(`UPDATE public.booking_waitlist_entries SET intent_json=` +
      `jsonb_build_object('serviceIds',jsonb_build_array('${uuid(91)}'),'addons',jsonb_build_array('${uuid(91)}')) WHERE id='${entry}'`);
    if(kind==="different_preferred_time")execute(`UPDATE public.booking_waitlist_entries SET preferred_slot_label='1:00 PM' WHERE id='${entry}'`);
    if(kind==="prep_overlap_after_catalog_change"){
      execute(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}'; ` +
        `INSERT INTO public.bookings(id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents) ` +
        `SELECT '${other}',salon_id,service_id,staff_id,resource_id,'Synthetic prep conflict','+16045550422',` +
        `start_time_utc-interval '30 minutes',start_time_utc-interval '5 minutes','confirmed',2500 FROM public.bookings WHERE id='${id}'; COMMIT; ` +
        `UPDATE public.services SET prep_minutes=10 WHERE id='${uuid(91)}'`);
    }
    if(kind==="prep_before_staff_shift")execute(`INSERT INTO public.staff_shifts(salon_id,staff_id,day_of_week,start_time,end_time,is_active) ` +
      `SELECT salon_id,staff_id,(ARRAY['sun','mon','tue','wed','thu','fri','sat'])[extract(dow FROM start_time_utc AT TIME ZONE 'America/Vancouver')::int+1],` +
      `'12:00','23:59',true FROM public.bookings WHERE id='${id}'`);
    try{
      const beforeBackground=background.after.mock.calls.length;
      const response=await POST(request(params)),original=receipt(messageSid);
      // Count a recorded legacy callback even on the red run, so an afterAll
      // failure does not obscure the actual unsafe offer assertion below.
      if((original?.result_json as Record<string,unknown>|undefined)?.promoted_waitlist)expectedBackground++;
      expect(response.status).toBe(200);expect(await response.text()).toContain("Your appointment is cancelled");
      expect(state(id)).toBe("cancelled");
      expect(original).toMatchObject({booking_id:id,result_json:{code:"applied",promoted_waitlist:null}});
      expect(promotionState(id,entry)).toMatchObject({entry:{status:"waiting"},capability_count:0,outbox:[]});
      expect(background.after).toHaveBeenCalledTimes(beforeBackground);
      expect((await POST(request(params))).status).toBe(200);expect(receipt(messageSid)).toEqual(original);
      expect(promotionState(id,entry)).toMatchObject({entry:{status:"waiting"},capability_count:0,outbox:[]});
      if(kind==="different_requested_staff"||kind==="insufficient_gap_after_catalog_change")expect(state(other)).toBe("confirmed");
    }finally{
      execute(`UPDATE public.salons SET profile_complete=true,booking_closed_dates='[]'::jsonb WHERE id='${uuid(90)}'; ` +
        `UPDATE public.services SET duration_minutes=30,prep_minutes=5 WHERE id='${uuid(91)}'; ` +
        `DELETE FROM public.staff_shifts WHERE salon_id='${uuid(90)}' AND staff_id='${uuid(92)}'`);
    }
  });
  it.skipIf(!eligibilityBatch)("skips an incompatible earlier waiter and binds the first compatible public individual intent to the catalog duration",async()=>{
    const id=sequenceBooking(470,"+16045550228"),other=uuid(3470);
    execute(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}'; ` +
      `INSERT INTO public.bookings(id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents) ` +
      `SELECT '${other}',salon_id,service_id,'${uuid(96)}','${uuid(97)}','Synthetic requested staff','+16045550423',` +
      `start_time_utc,start_time_utc+interval '30 minutes','confirmed',2500 FROM public.bookings WHERE id='${id}'; COMMIT`);
    const skipped=waiter(2470,id,uuid(96)),selected=waiter(2471,id,uuid(92));
    execute(`UPDATE public.booking_waitlist_entries SET created_at=created_at-interval '1 minute' WHERE id='${skipped}'; ` +
      `UPDATE public.booking_waitlist_entries SET intent_json=jsonb_build_object('serviceIds',jsonb_build_array('${uuid(91)}'),` +
      `'staffPreference','${uuid(92)}','source','slot_unavailable') WHERE id='${selected}'`);
    const messageSid=sid(),params=fields(messageSid,{From:"+16045550228"});
    expect((await POST(request(params))).status).toBe(200);expectedBackground++;
    const original=receipt(messageSid);
    expect(original).toMatchObject({result_json:{code:"applied",waitlist_result_code:"promoted",promoted_waitlist:{waitlist_entry_id:selected}}});
    expect(promotionState(id,skipped)).toMatchObject({entry:{status:"waiting"},capability_count:0,outbox:[]});
    expect(promotionState(id,selected)).toMatchObject({entry:{status:"notified",offered_staff_id:uuid(92)},capability_count:1});
    expect(sql<boolean>(`SELECT to_json(offered_end_utc=offered_start_utc+interval '30 minutes') FROM public.booking_waitlist_entries WHERE id='${selected}'`)).toBe(true);
    expect((await POST(request(params))).status).toBe(200);expectedBackground++;expect(receipt(messageSid)).toEqual(original);
    expect(promotionState(id,selected)).toMatchObject({promotion_count:1,capability_count:1});expect(state(other)).toBe("confirmed");
  });
});

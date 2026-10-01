import { execFileSync, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { claimWaitlistSlot, loadWaitlistClaimPreview } from "./waitlistClaim";

const enabled = process.env.NAILIQ_LOCAL_ATOMIC_INBOUND_INTEGRATION === "1";
const database = process.env.NAILIQ_LOCAL_INBOUND_DATABASE;
const origin = "http://127.0.0.1:54442";
const uuid = (n: number) => `30300930-0000-4000-8000-${String(n).padStart(12, "0")}`;
const salon = uuid(1), service = uuid(2), staff = uuid(3), otherStaff = uuid(4), bed = uuid(5);

describe.skipIf(!enabled)("real Waitlist claim client through isolated HTTP and PostgreSQL", () => {
  let outsideAttempts = 0;
  let dropNextCommittedClaimResponse = false;
  let injectedClaimDrops = 0;
  let claimHttpRequests = 0;
  let lastRpcError: {status:number;code:string}|undefined;
  function sql<T>(statement: string): T {
    if (!database || !/^nailiq_inbound_atomic_20260930_b(?:1[789]|2[0123456789]|3[0123456789]|5[0123])$/u.test(database) ||
        process.env.NEXT_PUBLIC_SUPABASE_URL !== origin || process.env.SUPABASE_INTERNAL_URL ||
        process.env.NAILIQ_DISPOSABLE_DB !== "1") throw Error("not_isolated_local");
    return JSON.parse(execFileSync("docker", ["--context", "colima-nailiq-p0-503", "exec",
      "supabase_db_nailiq-day5-20260924", "psql", "-U", "postgres", "-d", database,
      "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", statement],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  }
  function execute(statement: string) { sql(statement + "; SELECT 'true'::json"); }
  function writer(n:number, sameStaff=false) {
    if(!database || !/^nailiq_inbound_atomic_20260930_b(?:2[23456789]|3[0123456789]|5[0123])$/u.test(database)) throw Error("not_isolated_race_database");
    const child=spawn("docker",["--context","colima-nailiq-p0-503","exec","supabase_db_nailiq-day5-20260924",
      "psql","-U","postgres","-d",database,"-X","-q","-A","-t","-v","ON_ERROR_STOP=1","-c",
      `BEGIN; SET LOCAL statement_timeout='8s'; SET LOCAL request.jwt.claims='{"role":"service_role"}';
        WITH result AS (SELECT public.create_public_booking('${salon}','${uuid(6)}','${sameStaff?staff:otherStaff}',
          'Synthetic concurrent guest','+16045550403',start_time_utc-interval '19 minutes',
          start_time_utc-interval '4 minutes','confirmed',1000,NULL,NULL,NULL,NULL,'${bed}') AS body
          FROM public.bookings WHERE id='${uuid(n)}')
        SELECT json_build_object('success',body->'success','code',body->>'code') FROM result;
        COMMIT; /* QA_CLAIM_RACE_${n} */`],{stdio:"pipe"});
    let stdout="";child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.resume();
    return new Promise<{success:boolean;code:string}>((resolve,reject)=>{
      child.once("error",()=>reject(Error("local_writer_transport_failed")));
      child.once("exit",exit=>{
        if(exit!==0){reject(Error("local_writer_transaction_failed"));return;}
        try {resolve(JSON.parse(stdout));} catch {reject(Error("local_writer_result_invalid"));}
      });
    });
  }
  async function observe(statement:string) {
    for(let i=0;i<50;i++){
      if(sql<boolean>(statement))return true;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    return false;
  }
  function offer(n: number) {
    execute(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}';
      INSERT INTO public.bookings(id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,
        start_time_utc,end_time_utc,status,price_cents)
      VALUES('${uuid(n)}','${salon}','${service}','${staff}','${bed}','Synthetic original','+16045550401',
        ((now() AT TIME ZONE 'America/Vancouver')::date+${n}+time '12:00') AT TIME ZONE 'America/Vancouver',
        ((now() AT TIME ZONE 'America/Vancouver')::date+${n}+time '12:30') AT TIME ZONE 'America/Vancouver','confirmed',2500);
      INSERT INTO public.booking_waitlist_entries(id,salon_id,service_id,staff_id,booking_date,
        preferred_slot_label,client_name,client_phone,client_email,source)
      SELECT '${uuid(n+1000)}',salon_id,service_id,staff_id,(start_time_utc AT TIME ZONE 'America/Vancouver')::date,
        '12:00 PM','Synthetic waiter','+16045550402','claim@example.invalid','slot_unavailable'
      FROM public.bookings WHERE id='${uuid(n)}';
      DO $test$ BEGIN PERFORM public.cancel_booking_with_verified_sms_waitlist('${uuid(n)}'); END $test$; COMMIT`);
    const token = sql<string>(`SELECT to_json(id) FROM public.waitlist_claim_capabilities
      WHERE waitlist_entry_id='${uuid(n+1000)}' AND consumed_at IS NULL AND revoked_at IS NULL`);
    expect(token).toMatch(/^[0-9a-f-]{36}$/u);
    return { token, entry: uuid(n+1000), booking: uuid(n) };
  }
  function state(entry: string) {
    expect(entry).toMatch(/^30300930-0000-4000-8000-[0-9]{12}$/u);
    return sql<{status:string;booked_booking_id:string|null;claimed_at:string|null;receipts:number;bookings:number;caps:number}>(
      `SELECT json_build_object('status',w.status,'booked_booking_id',w.booked_booking_id,'claimed_at',w.claimed_at,
        'receipts',(SELECT count(*) FROM public.waitlist_claim_action_receipts WHERE waitlist_entry_id=w.id),
        'caps',(SELECT count(*) FROM public.waitlist_claim_capabilities WHERE waitlist_entry_id=w.id),
        'bookings',(SELECT count(*) FROM public.bookings b WHERE b.salon_id=w.salon_id
          AND (b.start_time_utc AT TIME ZONE 'America/Vancouver')::date=w.booking_date AND b.status='confirmed'))
       FROM public.booking_waitlist_entries w WHERE w.id='${entry}'`);
  }
  // Use the real cancellation/promotion path, with an explicit UTC instant.
  // Fixed dates are future DST fixtures, not a changed database/system clock.
  function timedOffer(n:number,startUtc:string,timeZone="America/Vancouver",blockLater=false) {
    if(!/^2027-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/u.test(startUtc) ||
      !["America/Vancouver","America/Los_Angeles","Asia/Kolkata"].includes(timeZone))throw Error("invalid_synthetic_time");
    execute(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}';
      UPDATE public.salons SET timezone='${timeZone}' WHERE id='${salon}';
      INSERT INTO public.bookings(id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,
        start_time_utc,end_time_utc,status,price_cents)
      VALUES('${uuid(n)}','${salon}','${service}','${staff}','${bed}','Synthetic time original','+16045550401',
        '${startUtc}'::timestamptz,'${startUtc}'::timestamptz+interval '30 minutes','confirmed',2500);
      ${blockLater?`INSERT INTO public.bookings(id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,
        start_time_utc,end_time_utc,status,price_cents)
        SELECT '${uuid(n+2000)}',salon_id,service_id,staff_id,resource_id,'Synthetic later occurrence','+16045550403',
          start_time_utc+interval '1 hour',end_time_utc+interval '1 hour','confirmed',price_cents
        FROM public.bookings WHERE id='${uuid(n)}';`:""}
      INSERT INTO public.booking_waitlist_entries(id,salon_id,service_id,staff_id,booking_date,
        preferred_slot_label,client_name,client_phone,client_email,source)
      SELECT '${uuid(n+1000)}',salon_id,service_id,staff_id,(start_time_utc AT TIME ZONE '${timeZone}')::date,
        to_char(start_time_utc AT TIME ZONE '${timeZone}','FMHH12:MI AM'),
        'Synthetic time waiter','+16045550402','time-claim@example.invalid','slot_unavailable'
      FROM public.bookings WHERE id='${uuid(n)}';
      ${blockLater?`UPDATE public.bookings SET status='cancelled' WHERE id='${uuid(n+2000)}';`:""}
      DO $test$ BEGIN PERFORM public.cancel_booking_with_verified_sms_waitlist('${uuid(n)}'); END $test$; COMMIT`);
    const token=sql<string|null>(`SELECT coalesce(to_json((SELECT id FROM public.waitlist_claim_capabilities
      WHERE waitlist_entry_id='${uuid(n+1000)}' AND consumed_at IS NULL AND revoked_at IS NULL LIMIT 1)),'null'::json)`);
    return {token,entry:uuid(n+1000),booking:uuid(n)};
  }
  function finishTimedFixture(entry:string) {
    expect(entry).toMatch(/^30300930-0000-4000-8000-[0-9]{12}$/u);
    // Retain all synthetic evidence; expire remaining waiters so a later test
    // cannot invite an earlier fixture. Release only this fixture's booking.
    execute(`UPDATE public.bookings SET status='cancelled' WHERE id=(SELECT booked_booking_id
        FROM public.booking_waitlist_entries WHERE id='${entry}');
      UPDATE public.booking_waitlist_entries SET status='expired' WHERE id='${entry}' AND status IN ('waiting','notified');
      UPDATE public.services SET prep_minutes=0,buffer_minutes=0 WHERE id='${service}';
      UPDATE public.salons SET timezone='America/Vancouver' WHERE id='${salon}'`);
  }
  function takeSlot(n: number, other = false) {
    execute(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}';
      INSERT INTO public.bookings(id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,
        start_time_utc,end_time_utc,status,price_cents)
      SELECT '${uuid(n+2000)}',salon_id,service_id,'${other?otherStaff:staff}',resource_id,
        'Synthetic competing guest','+16045550403',start_time_utc,end_time_utc,'confirmed',price_cents
      FROM public.bookings WHERE id='${uuid(n)}'; COMMIT`);
  }
  beforeAll(() => {
    const owner = sql<string>("SELECT to_json(shobj_description(oid,'pg_database')) FROM pg_database WHERE datname=current_database()");
    expect(owner).toBe("Owned synthetic P1-01 local test 20260930; no production or customer data");
    expect(sql<number>("SELECT to_json(count(*)) FROM public.salons")).toBe(0);
    execute(`INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('e2e-claim','Synthetic','Synthetic');
      INSERT INTO public.salons(id,slug,name,phone,timezone,is_beta,profile_complete,resources_enabled,feature_flags,opening_hours)
      SELECT '${salon}','e2e-claim-atomic','Synthetic claim','+16045550400','America/Vancouver',true,true,true,
        '{"waitlist_auto_book":true}'::jsonb,jsonb_object_agg(day,jsonb_build_object('open','00:00','close','23:59','closed',false))
      FROM unnest(ARRAY['sun','mon','tue','wed','thu','fri','sat']) AS day;
      INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,prep_minutes,buffer_minutes,category,
        resource_requirement_mode,required_resource_kinds)
      VALUES('${service}','${salon}','Synthetic claim service',2500,30,0,0,'e2e-claim','specific',ARRAY['bed']);
      INSERT INTO public.staff(id,salon_id,name,status) VALUES('${staff}','${salon}','Synthetic A','active'),
        ('${otherStaff}','${salon}','Synthetic B','active');
      INSERT INTO public.salon_resources(id,salon_id,name,kind) VALUES('${bed}','${salon}','Synthetic bed','bed')`);
    // Authorize only this synthetic salon's existing sequence contract. This
    // does not bypass any trigger, OTP, health or payment guard.
    execute(`INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,prep_minutes,buffer_minutes,category)
      VALUES('${uuid(6)}','${salon}','Synthetic second service',1000,15,0,0,'e2e-claim');
      INSERT INTO public.platform_flags(key,enabled) VALUES('feature_multi_service_booking',true)
      ON CONFLICT(key) DO UPDATE SET enabled=true;
      INSERT INTO public.platform_settings(id,multi_service_booking_qa_salon_id) VALUES('platform','${salon}')
      ON CONFLICT(id) DO UPDATE SET multi_service_booking_qa_salon_id='${salon}';
      UPDATE public.salons SET tax_lines='[]'::jsonb,
        feature_flags=feature_flags||'{"multi_service_booking_enabled":true}'::jsonb WHERE id='${salon}'`);
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== origin) { outsideAttempts++; throw Error("non_local_transport_forbidden"); }
      let transportInit=init;
      if(url.pathname==="/rest/v1/rpc/claim_waitlist_with_management_capability"){
        claimHttpRequests++;
        if(dropNextCommittedClaimResponse){
          dropNextCommittedClaimResponse=false;
          injectedClaimDrops++;
          const headers=new Headers(init?.headers ?? (input instanceof Request?input.headers:undefined));
          // Only the isolated loopback gateway implements this test header.
          // It drains the real PostgREST response, then destroys the socket
          // without forwarding response bytes; no RPC result is mocked here.
          headers.set("x-nailiq-local-drop-committed-claim-response","1");
          transportInit={...init,headers};
        }
      }
      const response=await original(input,transportInit);
      if(response.status>=400){
        const body=await response.clone().json().catch(()=>({}));
        lastRpcError={status:response.status,code:typeof body.code==="string"&&/^[A-Z0-9]+$/u.test(body.code)?body.code:"unknown"};
      }else lastRpcError=undefined;
      return response;
    });
  });
  afterAll(() => {
    expect(outsideAttempts).toBe(0);
    expect(sql<number>("SELECT to_json(deadlocks) FROM pg_stat_database WHERE datname=current_database()")).toBe(0);
    vi.unstubAllGlobals();
  });
  it("books exactly once and replays an identical command without duplicate receipt", async () => {
    const item = offer(10);
    expect(await loadWaitlistClaimPreview(item.token)).toEqual({ state: "available" });
    expect(await claimWaitlistSlot(item.token,uuid(3010))).toEqual({ ok:true,outcome:"booked" });
    const first = state(item.entry);
    expect(first.status).toBe("claimed"); expect(first.booked_booking_id).not.toBeNull();
    expect(first.bookings).toBe(1); expect(first.receipts).toBe(1);
    expect(await claimWaitlistSlot(item.token,uuid(3010))).toEqual({ ok:true,outcome:"booked" });
    expect(state(item.entry)).toEqual(first);
    expect(await claimWaitlistSlot(item.token,uuid(4010))).toEqual({ ok:false,reason:"unavailable" });
    expect(state(item.entry)).toEqual(first);
  });
  it("recovers an already committed booking after a lost HTTP response without duplicate booking or receipt", async () => {
    const item=offer(15),requestId=uuid(3015);
    const requestsBefore=claimHttpRequests,dropsBefore=injectedClaimDrops;
    dropNextCommittedClaimResponse=true;
    try{
      expect(await claimWaitlistSlot(item.token,requestId)).toEqual({ok:false,reason:"error"});
      expect(injectedClaimDrops-dropsBefore).toBe(1);
      expect(claimHttpRequests-requestsBefore).toBe(1);
      const committed=state(item.entry);
      expect(committed).toMatchObject({status:"claimed",bookings:1,receipts:1});
      expect(committed.booked_booking_id).not.toBeNull();
      expect(committed.claimed_at).not.toBeNull();
      expect(await claimWaitlistSlot(item.token,requestId)).toEqual({ok:true,outcome:"booked"});
      expect(claimHttpRequests-requestsBefore).toBe(2);
      expect(state(item.entry)).toEqual(committed);
      expect(await claimWaitlistSlot(item.token,uuid(4015))).toEqual({ok:false,reason:"unavailable"});
      expect(state(item.entry)).toEqual(committed);
    }finally{dropNextCommittedClaimResponse=false;}
  });
  it("does not book when another guest takes the offered staff slot before claim", async () => {
    const item=offer(20); takeSlot(20);
    expect(await claimWaitlistSlot(item.token,uuid(3020))).toEqual({ ok:false,reason:"unavailable" });
    expect(state(item.entry)).toMatchObject({status:"waiting",bookings:1,booked_booking_id:null,claimed_at:null,receipts:1});
    expect(await claimWaitlistSlot(item.token,uuid(3020))).toEqual({ok:false,reason:"unavailable"});
    expect(state(item.entry).receipts).toBe(1);
  });
  it("does not book when another staff occupies the only bed", async () => {
    const item=offer(30); takeSlot(30,true);
    expect(await claimWaitlistSlot(item.token,uuid(3030))).toEqual({ok:false,reason:"unavailable"});
    expect(state(item.entry)).toMatchObject({status:"waiting",bookings:1,booked_booking_id:null,receipts:1});
  });
  it("serializes two simultaneous claim commands into one booking and one receipt", async () => {
    const item=offer(40);
    const holder=spawn("docker",["--context","colima-nailiq-p0-503","exec","supabase_db_nailiq-day5-20260924",
      "psql","-U","postgres","-d",database!,"-X","-q","-A","-t","-v","ON_ERROR_STOP=1","-c",
      `BEGIN; SELECT id FROM public.booking_waitlist_entries WHERE id='${item.entry}' FOR UPDATE; SELECT pg_sleep(3); COMMIT`],{stdio:"pipe"});
    const done=new Promise<number|null>((resolve,reject)=>{holder.once("error",reject);holder.once("exit",resolve);});
    let observed=false;
    for(let i=0;i<40;i++) {
      if(sql<boolean>(`SELECT to_json(EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND query LIKE '%${item.entry}%' AND wait_event='PgSleep'))`)){observed=true;break;}
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    if(!observed){await done;throw Error("claim_lock_holder_not_proven");}
    const pending=Promise.all([claimWaitlistSlot(item.token,uuid(3040)),claimWaitlistSlot(item.token,uuid(4040))]);
    let overlapping=false;
    for(let i=0;i<40;i++) {
      if(sql<number>(`SELECT to_json(count(*)) FROM pg_stat_activity WHERE datname=current_database()
        AND query LIKE '%claim_waitlist_with_management_capability%' AND wait_event_type='Lock'` )>=2){overlapping=true;break;}
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    const holderExit=await done,results=await pending;
    expect(holderExit).toBe(0);expect(overlapping).toBe(true);
    expect(results.filter(r=>r.ok)).toHaveLength(1);
    expect(results.filter(r=>!r.ok)).toEqual([{ok:false,reason:"unavailable"}]);
    expect(state(item.entry)).toMatchObject({status:"claimed",bookings:1,receipts:1});
  },10000);
  it("rejects expired and revoked capabilities without booking or consuming a receipt", async () => {
    for(const n of [50,60]) {
      const item=offer(n);
      execute(`UPDATE public.waitlist_claim_capabilities SET ${n===50?"expires_at=now()-interval '1 second'":"revoked_at=now()"} WHERE id='${item.token}'`);
      expect(await claimWaitlistSlot(item.token,uuid(n+3000))).toEqual({ok:false,reason:"unavailable"});
      expect(state(item.entry)).toMatchObject({status:"notified",bookings:0,receipts:0});
    }
  });
  it("rejects a newly unavailable staff member instead of treating a token as a reservation", async () => {
    const item=offer(70);
    execute(`INSERT INTO public.staff_unavailability(staff_id,salon_id,date,reason)
      SELECT '${staff}','${salon}',booking_date,'Synthetic approved absence' FROM public.booking_waitlist_entries WHERE id='${item.entry}'`);
    expect(await claimWaitlistSlot(item.token,uuid(3070))).toEqual({ok:false,reason:"unavailable"});
    expect(state(item.entry).bookings).toBe(0);
  });
  it("does not book after the salon closes the offered business date", async () => {
    const item=offer(80);
    execute(`UPDATE public.salons SET booking_closed_dates=(SELECT jsonb_build_array(booking_date::text)
      FROM public.booking_waitlist_entries WHERE id='${item.entry}') WHERE id='${salon}'`);
    try {
      expect(await claimWaitlistSlot(item.token,uuid(3080))).toEqual({ok:false,reason:"unavailable"});
      expect(state(item.entry).bookings).toBe(0);
    } finally { execute(`UPDATE public.salons SET booking_closed_dates='[]'::jsonb WHERE id='${salon}'`); }
  });
  it("fails closed when salon readiness becomes unverifiable after the offer", async () => {
    const item=offer(90); execute(`UPDATE public.salons SET profile_complete=false WHERE id='${salon}'`);
    try {
      expect(await claimWaitlistSlot(item.token,uuid(3090))).toEqual({ok:false,reason:"unavailable"});
      const first=state(item.entry);
      expect(first).toMatchObject({status:"waiting",bookings:0,booked_booking_id:null,claimed_at:null,receipts:1});
      expect(await claimWaitlistSlot(item.token,uuid(3090))).toEqual({ok:false,reason:"unavailable"});
      expect(state(item.entry)).toEqual(first);
    } finally { execute(`UPDATE public.salons SET profile_complete=true WHERE id='${salon}'`); }
  });
  it("rejects a stale epoch without claiming the current entry",async()=>{
    const item=offer(100);
    execute(`UPDATE public.waitlist_claim_action_state SET epoch=epoch+1 WHERE waitlist_entry_id='${item.entry}'`);
    expect(await claimWaitlistSlot(item.token,uuid(3100))).toEqual({ok:false,reason:"unavailable"});
    expect(state(item.entry)).toMatchObject({status:"notified",bookings:0,receipts:0});
  });
  it("does not book when newly required preparation overlaps another staff booking",async()=>{
    const item=offer(120);
    execute(`INSERT INTO public.bookings(id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,
      start_time_utc,end_time_utc,status,price_cents)
      SELECT '${uuid(2120)}',salon_id,service_id,staff_id,resource_id,'Synthetic preceding guest','+16045550403',
        start_time_utc-interval '35 minutes',start_time_utc-interval '5 minutes','confirmed',2500
      FROM public.bookings WHERE id='${item.booking}';
      UPDATE public.services SET prep_minutes=10 WHERE id='${service}'`);
    try {
      expect(await claimWaitlistSlot(item.token,uuid(3120))).toEqual({ok:false,reason:"unavailable"});
      expect(state(item.entry)).toMatchObject({status:"waiting",bookings:1,receipts:1,booked_booking_id:null});
    } finally {execute(`UPDATE public.services SET prep_minutes=0 WHERE id='${service}'`);}
  });
  it("does not book when preparation is outside the offered staff shift",async()=>{
    const item=offer(130);
    execute(`INSERT INTO public.staff_shifts(staff_id,salon_id,day_of_week,start_time,end_time,is_active)
      SELECT '${staff}','${salon}',lower(to_char(booking_date,'dy')),'12:00','18:00',true
      FROM public.booking_waitlist_entries WHERE id='${item.entry}';
      UPDATE public.services SET prep_minutes=5 WHERE id='${service}'`);
    try {
      expect(await claimWaitlistSlot(item.token,uuid(3130))).toEqual({ok:false,reason:"unavailable"});
      expect(state(item.entry)).toMatchObject({status:"waiting",bookings:0,receipts:1});
    } finally {
      execute(`DELETE FROM public.staff_shifts WHERE staff_id='${staff}' AND salon_id='${salon}';
        UPDATE public.services SET prep_minutes=0 WHERE id='${service}'`);
    }
  });
  it("does not book when preparation overlaps an approved break",async()=>{
    const item=offer(140);
    execute(`INSERT INTO public.staff_shifts(staff_id,salon_id,day_of_week,start_time,end_time,is_active,break_start_time,break_end_time)
      SELECT '${staff}','${salon}',lower(to_char(booking_date,'dy')),'09:00','18:00',true,'11:45','11:58'
      FROM public.booking_waitlist_entries WHERE id='${item.entry}';
      UPDATE public.services SET prep_minutes=10 WHERE id='${service}'`);
    try {
      expect(await claimWaitlistSlot(item.token,uuid(3140))).toEqual({ok:false,reason:"unavailable"});
      expect(state(item.entry)).toMatchObject({status:"waiting",bookings:0,receipts:1});
    } finally {
      execute(`DELETE FROM public.staff_shifts WHERE staff_id='${staff}' AND salon_id='${salon}';
        UPDATE public.services SET prep_minutes=0 WHERE id='${service}'`);
    }
  });
  it("does not book when preparation overlaps the only bed used by another technician",async()=>{
    const item=offer(150);
    execute(`INSERT INTO public.bookings(id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,
      start_time_utc,end_time_utc,status,price_cents)
      SELECT '${uuid(2150)}',salon_id,service_id,'${otherStaff}',resource_id,'Synthetic preceding bed guest','+16045550403',
        start_time_utc-interval '35 minutes',start_time_utc-interval '5 minutes','confirmed',2500
      FROM public.bookings WHERE id='${item.booking}'; UPDATE public.services SET prep_minutes=10 WHERE id='${service}'`);
    try {
      expect(await claimWaitlistSlot(item.token,uuid(3150))).toEqual({ok:false,reason:"unavailable"});
      expect(state(item.entry)).toMatchObject({status:"waiting",bookings:1,receipts:1,booked_booking_id:null});
    } finally {execute(`UPDATE public.services SET prep_minutes=0 WHERE id='${service}'`);}
  });
  it("persists preparation and buffer without changing customer time and blocks later competing writes",async()=>{
    const item=offer(160);
    execute(`UPDATE public.services SET prep_minutes=5,buffer_minutes=10 WHERE id='${service}'`);
    try {
      expect(await claimWaitlistSlot(item.token,uuid(3160))).toEqual({ok:true,outcome:"booked"});
      const first=state(item.entry);expect(first).toMatchObject({status:"claimed",bookings:1,receipts:1});
      expect(sql<{model:string;segments:number;correct:boolean}>(`SELECT json_build_object('model',b.schedule_model,
        'segments',(SELECT count(*) FROM public.booking_service_segments seg WHERE seg.booking_id=b.id),
        'correct',EXISTS(SELECT 1 FROM public.booking_service_segments seg WHERE seg.booking_id=b.id
          AND seg.customer_start_utc=w.offered_start_utc AND seg.customer_end_utc=w.offered_end_utc
          AND seg.occupied_start_utc=w.offered_start_utc-interval '5 minutes'
          AND seg.occupied_end_utc=w.offered_end_utc+interval '10 minutes'
          AND b.start_time_utc=w.offered_start_utc AND b.end_time_utc=w.offered_end_utc))
        FROM public.booking_waitlist_entries w JOIN public.bookings b ON b.id=w.booked_booking_id WHERE w.id='${item.entry}'`))
        .toEqual({model:"segments_v1",segments:1,correct:true});
      expect(await claimWaitlistSlot(item.token,uuid(3160))).toEqual({ok:true,outcome:"booked"});
      expect(state(item.entry)).toEqual(first);
      const blocked=sql<string[]>(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}';
        SELECT json_agg(code ORDER BY minutes) FROM (
        SELECT minutes, public.create_public_booking('${salon}','${service}','${otherStaff}',
          'Synthetic bed contender','+16045550403',w.offered_start_utc+make_interval(mins=>minutes),
          w.offered_start_utc+make_interval(mins=>minutes+30),'confirmed',2500,NULL,NULL,NULL,NULL,'${bed}')->>'code' AS code
        FROM public.booking_waitlist_entries w CROSS JOIN unnest(ARRAY[-34,35]) AS minutes WHERE w.id='${item.entry}'
      ) attempts; COMMIT`);
      expect(blocked).toHaveLength(2);expect(blocked.every(code=>code==="slot_conflict")).toBe(true);
      expect(state(item.entry)).toEqual(first);
    } finally {execute(`UPDATE public.services SET prep_minutes=0,buffer_minutes=0 WHERE id='${service}'`);}
  });
  it("never falls back to an unsafe legacy booking when the segment rollout is OFF",async()=>{
    const item=offer(170);
    execute(`UPDATE public.services SET prep_minutes=5 WHERE id='${service}';
      UPDATE public.platform_flags SET enabled=false WHERE key='feature_multi_service_booking'`);
    try {
      expect(await claimWaitlistSlot(item.token,uuid(3170))).toEqual({ok:false,reason:"unavailable"});
      expect(state(item.entry)).toMatchObject({status:"waiting",bookings:0,receipts:1});
    } finally {execute(`UPDATE public.services SET prep_minutes=0 WHERE id='${service}';
      UPDATE public.platform_flags SET enabled=true WHERE key='feature_multi_service_booking'`);}
  });
  it("does not bypass OTP or health acknowledgement to persist preparation",async()=>{
    for(const [n,setting] of [[180,"phone_otp_enabled"],[190,"health_ack_required"]] as const){
      const item=offer(n);
      execute(`UPDATE public.services SET prep_minutes=5 WHERE id='${service}';
        UPDATE public.salons SET ${setting}=true WHERE id='${salon}'`);
      try {
        expect(await claimWaitlistSlot(item.token,uuid(n+3000))).toEqual({ok:false,reason:"unavailable"});
        expect(state(item.entry)).toMatchObject({status:"waiting",bookings:0,receipts:1});
      } finally {execute(`UPDATE public.services SET prep_minutes=0 WHERE id='${service}';
        UPDATE public.salons SET ${setting}=false WHERE id='${salon}'`);}
    }
  });
  it("rolls back booking and token when durable receipt fails, then retries exactly once",async()=>{
    const item=offer(110);
    execute(`CREATE SCHEMA qa_claim_fault; CREATE TABLE qa_claim_fault.switch(enabled boolean NOT NULL);
      INSERT INTO qa_claim_fault.switch VALUES(true);
      CREATE FUNCTION qa_claim_fault.reject_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $fault$
      BEGIN IF NEW.request_id='${uuid(3110)}' AND (SELECT enabled FROM qa_claim_fault.switch) THEN
        RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='synthetic_claim_receipt_fault'; END IF; RETURN NEW; END $fault$;
      CREATE TRIGGER qa_claim_receipt_fault BEFORE INSERT ON public.waitlist_claim_action_receipts
        FOR EACH ROW EXECUTE FUNCTION qa_claim_fault.reject_receipt()`);
    try {
      expect(await claimWaitlistSlot(item.token,uuid(3110))).toEqual({ok:false,reason:"error"});
      expect(state(item.entry)).toMatchObject({status:"notified",bookings:0,receipts:0,claimed_at:null,booked_booking_id:null});
    } finally { execute("UPDATE qa_claim_fault.switch SET enabled=false"); }
    expect(await claimWaitlistSlot(item.token,uuid(3110))).toEqual({ok:true,outcome:"booked"});
    const first=state(item.entry);expect(first).toMatchObject({status:"claimed",bookings:1,receipts:1});
    expect(await claimWaitlistSlot(item.token,uuid(3110))).toEqual({ok:true,outcome:"booked"});
    expect(state(item.entry)).toEqual(first);
  });
  it("rolls back the inserted service segment when the final claim receipt fails",async()=>{
    const item=offer(210);
    execute(`UPDATE public.services SET prep_minutes=5,buffer_minutes=10 WHERE id='${service}';
      UPDATE qa_claim_fault.switch SET enabled=true;
      CREATE OR REPLACE FUNCTION qa_claim_fault.reject_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $fault$
      BEGIN IF NEW.request_id='${uuid(3210)}' AND (SELECT enabled FROM qa_claim_fault.switch) THEN
        RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='synthetic_segment_claim_receipt_fault'; END IF; RETURN NEW; END $fault$`);
    const segments=()=>sql<number>(`SELECT to_json(count(*)) FROM public.booking_service_segments seg
      WHERE seg.line_id='${item.entry}'`);
    try {
      expect(await claimWaitlistSlot(item.token,uuid(3210))).toEqual({ok:false,reason:"error"});
      expect(state(item.entry)).toMatchObject({status:"notified",bookings:0,receipts:0,claimed_at:null,booked_booking_id:null});
      expect(segments()).toBe(0);
      execute("UPDATE qa_claim_fault.switch SET enabled=false");
      expect(await claimWaitlistSlot(item.token,uuid(3210))).toEqual({ok:true,outcome:"booked"});
      const first=state(item.entry);expect(first).toMatchObject({status:"claimed",bookings:1,receipts:1});
      expect(segments()).toBe(1);
      expect(await claimWaitlistSlot(item.token,uuid(3210))).toEqual({ok:true,outcome:"booked"});
      expect(state(item.entry)).toEqual(first);expect(segments()).toBe(1);
    } finally {execute(`UPDATE qa_claim_fault.switch SET enabled=false;
      UPDATE public.services SET prep_minutes=0,buffer_minutes=0 WHERE id='${service}'`);}
  });
  it.each([[220,false],[230,true]] as const)("keeps a concurrent legacy writer from taking claim prep (%i)",async(n,sameStaff)=>{
    const item=offer(n);
    execute(`UPDATE public.services SET prep_minutes=5,buffer_minutes=10 WHERE id='${service}';
      CREATE SCHEMA IF NOT EXISTS qa_claim_race;
      CREATE TABLE IF NOT EXISTS qa_claim_race.switch(enabled boolean NOT NULL);
      INSERT INTO qa_claim_race.switch SELECT true WHERE NOT EXISTS(SELECT 1 FROM qa_claim_race.switch);
      UPDATE qa_claim_race.switch SET enabled=true;
      CREATE OR REPLACE FUNCTION qa_claim_race.pause_segment() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $pause$
      BEGIN IF NEW.line_id='${item.entry}' AND (SELECT enabled FROM qa_claim_race.switch) THEN
        PERFORM pg_catalog.pg_sleep(3); END IF; RETURN NEW; END $pause$;
      DROP TRIGGER IF EXISTS zz_qa_claim_pause ON public.booking_service_segments;
      CREATE TRIGGER zz_qa_claim_pause BEFORE INSERT ON public.booking_service_segments
        FOR EACH ROW EXECUTE FUNCTION qa_claim_race.pause_segment()`);
    const pending=claimWaitlistSlot(item.token,uuid(n+3000));
    let competing:Promise<{success:boolean;code:string}>|undefined;
    try {
      const paused=await observe(`SELECT to_json(EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND query LIKE '%claim_waitlist_with_management_capability%' AND wait_event='PgSleep'))`);
      if(!paused){await pending;throw Error("claim_after_capacity_pause_not_proven");}
      competing=writer(n,sameStaff);
      const blocked=await observe(`SELECT to_json(EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND query LIKE '%QA_CLAIM_RACE_${n}%' AND wait_event_type='Lock'))`);
      const [claim,result]=await Promise.all([pending,competing]);
      expect(blocked).toBe(true);expect(claim).toEqual({ok:true,outcome:"booked"});
      expect(result).toEqual({success:false,code:"slot_conflict"});
      expect(state(item.entry)).toMatchObject({status:"claimed",bookings:1,receipts:1});
      expect(sql<number>(`SELECT to_json(count(*)) FROM public.booking_service_segments WHERE line_id='${item.entry}'`)).toBe(1);
    } finally {
      await Promise.allSettled([pending,...(competing?[competing]:[])]);
      execute(`UPDATE qa_claim_race.switch SET enabled=false;
        UPDATE public.services SET prep_minutes=0,buffer_minutes=0 WHERE id='${service}'`);
    }
  },10000);
  it("rejects claim when an overlapping legacy booking wins the observed concurrent race",async()=>{
    const item=offer(240);
    execute(`UPDATE public.services SET prep_minutes=5,buffer_minutes=10 WHERE id='${service}';
      UPDATE qa_claim_race.switch SET enabled=true;
      CREATE OR REPLACE FUNCTION qa_claim_race.pause_booking() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $pause$
      BEGIN IF NEW.salon_id='${salon}' AND NEW.client_name='Synthetic concurrent guest'
        AND NEW.start_time_utc=(SELECT start_time_utc-interval '19 minutes' FROM public.bookings WHERE id='${item.booking}')
        AND (SELECT enabled FROM qa_claim_race.switch) THEN PERFORM pg_catalog.pg_sleep(3); END IF; RETURN NEW; END $pause$;
      CREATE TRIGGER zz_qa_claim_legacy_pause BEFORE INSERT ON public.bookings
        FOR EACH ROW EXECUTE FUNCTION qa_claim_race.pause_booking()`);
    const competing=writer(240);
    let pending:ReturnType<typeof claimWaitlistSlot>|undefined;
    try {
      const paused=await observe(`SELECT to_json(EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND query LIKE '%QA_CLAIM_RACE_240%' AND wait_event='PgSleep'))`);
      if(!paused){await competing;throw Error("legacy_after_capacity_pause_not_proven");}
      pending=claimWaitlistSlot(item.token,uuid(3240));
      const blocked=await observe(`SELECT to_json(EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND query LIKE '%claim_waitlist_with_management_capability%' AND wait_event_type='Lock'))`);
      const [result,claim]=await Promise.all([competing,pending]);
      expect(blocked).toBe(true);expect(result).toMatchObject({success:true});
      expect(claim).toEqual({ok:false,reason:"unavailable"});
      expect(state(item.entry)).toMatchObject({status:"waiting",bookings:1,receipts:1,booked_booking_id:null});
      expect(sql<number>(`SELECT to_json(count(*)) FROM public.booking_service_segments WHERE line_id='${item.entry}'`)).toBe(0);
    } finally {
      await Promise.allSettled([competing,...(pending?[pending]:[])]);
      execute(`UPDATE qa_claim_race.switch SET enabled=false;
        UPDATE public.services SET prep_minutes=0,buffer_minutes=0 WHERE id='${service}'`);
    }
  },10000);
  it.each([
    {n:250,label:"requested technician changed",update:`staff_id='${otherStaff}'`},
    {n:260,label:"preferred time changed",update:"preferred_slot_label='1:00 PM'"},
    {n:270,label:"add-on constraint",update:`intent_json=jsonb_build_object('serviceIds',jsonb_build_array('${service}'),'addonServiceIds',jsonb_build_array('${uuid(6)}'))`},
    {n:280,label:"multiple requested services",update:`intent_json=jsonb_build_object('serviceIds',jsonb_build_array('${service}','${uuid(6)}'))`},
    {n:290,label:"different requested service",update:`intent_json=jsonb_build_object('serviceIds',jsonb_build_array('${uuid(6)}'))`},
    {n:300,label:"conflicting intent technician",update:`intent_json=jsonb_build_object('serviceIds',jsonb_build_array('${service}'),'staffPreference','${otherStaff}')`},
    {n:310,label:"missing requested service",update:"intent_json='{\"serviceIds\":[]}'::jsonb"},
    {n:320,label:"unverifiable staff preference",update:`intent_json=jsonb_build_object('serviceIds',jsonb_build_array('${service}'),'staffPreference',NULL)`},
    {n:330,label:"unknown source provenance",update:`intent_json=jsonb_build_object('serviceIds',jsonb_build_array('${service}'),'source','unknown')`},
    {n:340,label:"contradictory source provenance",update:`intent_json=jsonb_build_object('serviceIds',jsonb_build_array('${service}'),'source','booking_conflict')`},
  ])("does not reduce changed or unsupported Waitlist intent to one service ($label)",async({n,update})=>{
    const item=offer(n);
    // A capability is not authority to discard the current locked request.
    // Simulate stale/legacy intent with normal constraints/triggers still on.
    execute(`UPDATE public.booking_waitlist_entries SET ${update} WHERE id='${item.entry}'`);
    const intentBefore=sql<unknown>(`SELECT json_build_object('kind',request_kind,'partySize',party_size,
      'intent',intent_json,'source',source,'staff',staff_id,'preferred',preferred_slot_label)
      FROM public.booking_waitlist_entries WHERE id='${item.entry}'`);
    expect(await claimWaitlistSlot(item.token,uuid(n+3000))).toEqual({ok:false,reason:"unavailable"});
    expect(state(item.entry)).toMatchObject({status:"waiting",bookings:0,receipts:1,booked_booking_id:null,claimed_at:null});
    expect(sql<number>(`SELECT to_json(count(*)) FROM public.booking_service_segments WHERE line_id='${item.entry}'`)).toBe(0);
    expect(await claimWaitlistSlot(item.token,uuid(n+3000))).toEqual({ok:false,reason:"unavailable"});
    expect(state(item.entry).receipts).toBe(1);
    expect(sql<unknown>(`SELECT json_build_object('kind',request_kind,'partySize',party_size,
      'intent',intent_json,'source',source,'staff',staff_id,'preferred',preferred_slot_label)
      FROM public.booking_waitlist_entries WHERE id='${item.entry}'`)).toEqual(intentBefore);
  });
  it.each([[350,"group",4],[360,"sequence",1]] as const)("keeps complex request %i/%s in review without partial automatic booking",async(n,kind,partySize)=>{
    const item=offer(n);
    execute(`UPDATE public.booking_waitlist_entries SET request_kind='${kind}',party_size=${partySize},
      status='review_required',intent_json=jsonb_build_object('serviceIds',jsonb_build_array('${service}','${uuid(6)}'))
      WHERE id='${item.entry}'`);
    expect(await claimWaitlistSlot(item.token,uuid(n+3000))).toEqual({ok:false,reason:"unavailable"});
    expect(state(item.entry)).toMatchObject({status:"review_required",bookings:0,receipts:0,booked_booking_id:null});
    expect(sql<string>(`SELECT to_json(request_kind) FROM public.booking_waitlist_entries WHERE id='${item.entry}'`)).toBe(kind);
  });
  it.each([[370,false,0],[380,true,0],[390,false,5],[400,true,5]] as const)("preserves verified individual intent and source across claim and retry (%i)",async(n,anyStaff,prep)=>{
    const item=offer(n);
    const preference=anyStaff?"any":staff;
    execute(`UPDATE public.services SET prep_minutes=${prep} WHERE id='${service}';
      UPDATE public.booking_waitlist_entries SET staff_id=${anyStaff?"NULL":`'${staff}'`},
        source='booking_conflict',client_locale='vi',intent_json=jsonb_build_object(
          'serviceIds',jsonb_build_array('${service}'),'staffPreference','${preference}','source','booking_conflict')
        WHERE id='${item.entry}'`);
    try {
      expect(await claimWaitlistSlot(item.token,uuid(n+3000))).toEqual({ok:true,outcome:"booked"});
      expect(state(item.entry)).toMatchObject({status:"claimed",bookings:1,receipts:1});
      expect(await claimWaitlistSlot(item.token,uuid(n+3000))).toEqual({ok:true,outcome:"booked"});
      expect(state(item.entry).receipts).toBe(1);
      const saved=sql<{staff:string;service:string;startSame:boolean;source:string;locale:string;preference:string}>(
        `SELECT json_build_object('staff',b.staff_id,'service',b.service_id,
          'startSame',b.start_time_utc=w.offered_start_utc,'source',w.source,'locale',w.client_locale,
          'preference',w.intent_json->>'staffPreference') FROM public.booking_waitlist_entries w
          JOIN public.bookings b ON b.id=w.booked_booking_id WHERE w.id='${item.entry}'`);
      expect(saved).toEqual({staff,service,startSame:true,source:"booking_conflict",locale:"vi",preference});
    } finally {execute(`UPDATE public.services SET prep_minutes=0 WHERE id='${service}'`);}
  });
  it.each([
    ["anon","inspect_waitlist_claim_capability"],
    ["authenticated","inspect_waitlist_claim_capability"],
    ["anon","claim_waitlist_with_management_capability"],
    ["authenticated","claim_waitlist_with_management_capability"],
  ] as const)("denies %s direct execution of privileged %s through real HTTP",async(role,fn)=>{
    const item=offer(410+(["anon","authenticated"].indexOf(role))*20+
      (fn.startsWith("claim_")?10:0));
    const before=state(item.entry);
    const token=role==="anon"?process.env.E2E_INBOUND_ANON_TOKEN:process.env.E2E_INBOUND_AUTHENTICATED_TOKEN;
    expect(token).toBeTruthy();
    const response=await fetch(`${origin}/rest/v1/rpc/${fn}`,{method:"POST",
      headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
      body:JSON.stringify({p_token_id:item.token,...(fn.startsWith("claim_")?{p_request_id:uuid(9001)}:{})})});
    expect([401,403]).toContain(response.status);
    expect(await response.json()).toMatchObject({code:"42501"});
    expect(state(item.entry)).toEqual(before);
  });
  it("restricts Waitlist rows to the authenticated member's salon and blocks anon/non-members",()=>{
    const item=offer(450),foreignSalon=uuid(9),member=uuid(7),stranger=uuid(8);
    execute(`INSERT INTO public.salons(id,slug,name,phone,timezone) VALUES('${foreignSalon}','e2e-claim-foreign','Synthetic foreign','+16045550404','America/Vancouver');
      INSERT INTO auth.users(id,email) VALUES('${member}','member@example.invalid'),('${stranger}','stranger@example.invalid');
      INSERT INTO public.salon_members(salon_id,user_id,role) VALUES('${salon}','${member}','receptionist'),
        ('${foreignSalon}','${stranger}','owner')`);
    for(const [role,user,expected] of [["anon",null,0],["authenticated",null,0],
      ["authenticated",member,1],["authenticated",stranger,0]] as const){
      const result=sql<{role:string;visible:number}>(`BEGIN; SET LOCAL ROLE ${role};
        SET LOCAL request.jwt.claims='${JSON.stringify({role,...(user?{sub:user}:{})})}';
        SELECT json_build_object('role',current_user,'visible',count(*))
        FROM public.booking_waitlist_entries WHERE id='${item.entry}'; COMMIT`);
      expect(result).toEqual({role,visible:expected});
    }
  });
  it("prevents a capability from being rebound to another tenant at the composite foreign key",()=>{
    const item=offer(460),before=state(item.entry);
    const denied=sql<{denied:boolean;code:string}>(`DO $test$ BEGIN
      UPDATE public.waitlist_claim_capabilities SET salon_id='${uuid(9)}' WHERE id='${item.token}';
      RAISE EXCEPTION 'tenant_rebind_was_allowed'; EXCEPTION WHEN foreign_key_violation THEN NULL; END $test$;
      SELECT json_build_object('denied',salon_id='${salon}','code','23503')
      FROM public.waitlist_claim_capabilities WHERE id='${item.token}'`);
    expect(denied).toEqual({denied:true,code:"23503"});
    expect(state(item.entry)).toEqual(before);
  });
  it.each([0,5].flatMap(prep=>["missing_kind","inactive_bed","deleted_bed","compatible_chair","none","disabled"]
    .map((scenario,i)=>({prep,scenario,n:500+prep*100+i*10}))))(
    "enforces $scenario resource policy with prep $prep",async({prep,scenario,n})=>{
    const chair=uuid(9000+n);
    execute(`INSERT INTO public.salon_resources(id,salon_id,name,kind,status)
      VALUES('${chair}','${salon}','Synthetic chair','chair','inactive')`);
      const item=offer(n);
      if(scenario==="none"||scenario==="disabled")takeSlot(n,true);
      execute(`UPDATE public.services SET prep_minutes=${prep} WHERE id='${service}';
        UPDATE public.salon_resources SET status='active' WHERE id='${chair}'`);
      if(scenario==="missing_kind"||scenario==="compatible_chair"){
        execute(`UPDATE public.services SET required_resource_kinds=ARRAY['${scenario==="missing_kind"?"room":"chair"}'] WHERE id='${service}'`);
      }else if(scenario==="inactive_bed")execute(`UPDATE public.salon_resources SET status='inactive' WHERE id='${bed}'`);
      else if(scenario==="deleted_bed")execute(`UPDATE public.salon_resources SET deleted_at=now() WHERE id='${bed}'`);
      else if(scenario==="none")execute(`UPDATE public.services SET resource_requirement_mode='none',required_resource_kinds=ARRAY[]::text[] WHERE id='${service}'`);
      else execute(`UPDATE public.salons SET resources_enabled=false WHERE id='${salon}'`);
      try{
        const rejected=["missing_kind","inactive_bed","deleted_bed"].includes(scenario);
        const result=await claimWaitlistSlot(item.token,uuid(n+3000));
        expect(result,`${scenario}:${JSON.stringify(lastRpcError)}`).toEqual(rejected?{ok:false,reason:"unavailable"}:{ok:true,outcome:"booked"});
        expect(state(item.entry),scenario).toMatchObject({status:rejected?"waiting":"claimed",receipts:1});
        if(!rejected){
          const saved=sql<{resource:string|null;kind:string|null;startSame:boolean}>(`SELECT json_build_object(
            'resource',b.resource_id,'kind',r.kind,'startSame',b.start_time_utc=w.offered_start_utc)
            FROM public.booking_waitlist_entries w JOIN public.bookings b ON b.id=w.booked_booking_id
            LEFT JOIN public.salon_resources r ON r.id=b.resource_id WHERE w.id='${item.entry}'`);
          expect(saved,scenario).toEqual({resource:scenario==="compatible_chair"?chair:null,
            kind:scenario==="compatible_chair"?"chair":null,startSame:true});
          if(prep>0)expect(sql<string|null>(`SELECT coalesce(to_json(resource_id),'null'::json) FROM public.booking_service_segments
            WHERE line_id='${item.entry}'`),scenario).toBe(scenario==="compatible_chair"?chair:null);
        }else expect(state(item.entry),scenario).toMatchObject({bookings:0,booked_booking_id:null});
        expect(await claimWaitlistSlot(item.token,uuid(n+3000)),scenario).toEqual(result);
        expect(state(item.entry).receipts,scenario).toBe(1);
      }finally{execute(`UPDATE public.services SET prep_minutes=0,resource_requirement_mode='specific',required_resource_kinds=ARRAY['bed'] WHERE id='${service}';
        UPDATE public.salons SET resources_enabled=true WHERE id='${salon}';
        UPDATE public.salon_resources SET status='active',deleted_at=NULL WHERE id='${bed}';
        UPDATE public.salon_resources SET status='inactive' WHERE id='${chair}'`);}
  },20000);
  it.each([true,false])("resets resource rules per canonical sequence line (no-resource first %s)",async(noneFirst)=>{
    const n=noneFirst?700:710,chair=uuid(n+9000),second=uuid(6);
    execute(`INSERT INTO public.salon_resources(id,salon_id,name,kind) VALUES('${chair}','${salon}','Synthetic sequence chair','chair');
      UPDATE public.services SET prep_minutes=5,resource_requirement_mode='${noneFirst?"none":"specific"}',
        required_resource_kinds=${noneFirst?"ARRAY[]::text[]":"ARRAY['chair']"} WHERE id='${service}';
      UPDATE public.services SET resource_requirement_mode='${noneFirst?"specific":"none"}',
        required_resource_kinds=${noneFirst?"ARRAY['chair']":"ARRAY[]::text[]"} WHERE id='${second}'`);
    try{
      const saved=sql<{success:boolean;code:string}>(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}';
        WITH request AS (SELECT jsonb_build_object('contract_version',1,'salon_id','${salon}','request_id','${uuid(n+3000)}',
          'requested_start_time_utc',((now() AT TIME ZONE 'America/Vancouver')::date+${n}+time '12:00') AT TIME ZONE 'America/Vancouver',
          'same_staff_for_all',false,'apply_email_discount',false,
          'customer',jsonb_build_object('name','Synthetic sequence guest','phone','+16045550405'),
          'lines',jsonb_build_array(jsonb_build_object('line_id','${uuid(n+6000)}','position',0,'service_id','${service}','staff_preference','${staff}','addon_service_ids','[]'::jsonb),
            jsonb_build_object('line_id','${uuid(n+6001)}','position',1,'service_id','${second}','staff_preference','${otherStaff}','addon_service_ids','[]'::jsonb))) AS body),
        quote AS (SELECT body,public.resolve_booking_sequence_pricing_and_schedule(body,false) AS price FROM request),
        result AS (SELECT public.create_public_booking_sequence(body||jsonb_build_object('expected_pricing_fingerprint',price->>'pricing_fingerprint')) AS body FROM quote)
        SELECT json_build_object('success',body->'success','code',body->>'code') FROM result;
        SET CONSTRAINTS ALL IMMEDIATE; COMMIT`);
      expect(saved).toEqual({success:true,code:"booked"});
      expect(sql<(string|null)[]>(`SELECT json_agg(seg.resource_id ORDER BY seg.position)
        FROM public.booking_service_segments seg JOIN public.bookings b ON b.id=seg.booking_id
        WHERE b.salon_id='${salon}' AND b.idempotency_key='${uuid(n+3000)}'`)).toEqual(noneFirst?[null,chair]:[chair,null]);
    }finally{execute(`UPDATE public.services SET prep_minutes=0,resource_requirement_mode='specific',required_resource_kinds=ARRAY['bed'] WHERE id='${service}';
      UPDATE public.services SET resource_requirement_mode='salon_default',required_resource_kinds=ARRAY[]::text[] WHERE id='${second}';
      UPDATE public.salon_resources SET status='inactive' WHERE id='${chair}'`);}
  });
  it("rejects explicit incompatible resource in the canonical quote without changing live state",()=>{
    execute(`UPDATE public.services SET resource_requirement_mode='specific',required_resource_kinds=ARRAY['chair'] WHERE id='${service}'`);
    try{
      const result=sql<{success:boolean;code:string}>(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}';
        WITH result AS (SELECT public.resolve_booking_sequence_pricing_and_schedule(jsonb_build_object(
          'contract_version',1,'salon_id','${salon}','request_id','${uuid(3720)}',
          'requested_start_time_utc',((now() AT TIME ZONE 'America/Vancouver')::date+720+time '12:00') AT TIME ZONE 'America/Vancouver',
          'customer',jsonb_build_object('name','Synthetic quote guest','phone','+16045550405'),
          'lines',jsonb_build_array(jsonb_build_object('line_id','${uuid(6720)}','position',0,'service_id','${service}',
            'staff_preference','${staff}','preferred_resource_id','${bed}','addon_service_ids','[]'::jsonb))),false) AS body)
        SELECT json_build_object('success',body->'success','code',body->>'code') FROM result; COMMIT`);
      expect(result).toEqual({success:false,code:"invalid_resource"});
      expect(sql<number>(`SELECT to_json(count(*)) FROM public.bookings WHERE idempotency_key='${uuid(3720)}'`)).toBe(0);
    }finally{execute(`UPDATE public.services SET required_resource_kinds=ARRAY['bed'] WHERE id='${service}'`);}
  });
  it.each([
    {n:20000,start:"2027-03-14T09:45:00Z",zone:"America/Vancouver",prep:0},
    {n:20010,start:"2027-03-14T10:15:00Z",zone:"America/Los_Angeles",prep:5},
    {n:20020,start:"2027-11-07T09:15:00Z",zone:"America/Vancouver",prep:0},
    {n:20030,start:"2027-11-07T09:15:00Z",zone:"America/Los_Angeles",prep:5},
    {n:20040,start:"2027-01-15T06:30:00Z",zone:"Asia/Kolkata",prep:5},
  ])("preserves exact UTC and duration at $start in $zone with prep $prep",async({n,start,zone,prep})=>{
    execute(`UPDATE public.services SET prep_minutes=${prep} WHERE id='${service}'`);
    const item=timedOffer(n,start,zone);
    try{
      expect(item.token).toMatch(/^[0-9a-f-]{36}$/u);
      expect(await claimWaitlistSlot(item.token!,uuid(n+3000))).toEqual({ok:true,outcome:"booked"});
      const saved=sql<{exact:boolean;duration:number;prep:number}>(`SELECT json_build_object(
        'exact',b.start_time_utc='${start}'::timestamptz,
        'duration',extract(epoch FROM b.end_time_utc-b.start_time_utc)/60,
        'prep',coalesce((SELECT extract(epoch FROM seg.customer_start_utc-seg.occupied_start_utc)/60
          FROM public.booking_service_segments seg WHERE seg.booking_id=b.id),0))
        FROM public.booking_waitlist_entries w JOIN public.bookings b ON b.id=w.booked_booking_id WHERE w.id='${item.entry}'`);
      expect(saved).toEqual({exact:true,duration:30,prep});
      expect(await claimWaitlistSlot(item.token!,uuid(n+3000))).toEqual({ok:true,outcome:"booked"});
      expect(state(item.entry).receipts).toBe(1);
    }finally{finishTimedFixture(item.entry);}
  });
  it.each([0,5])("does not promote the ambiguous earlier fall-back occurrence with prep %s",(prep)=>{
    execute(`UPDATE public.services SET prep_minutes=${prep} WHERE id='${service}'`);
    // Capacity's wall label resolves to the later occurrence. Occupy it for
    // the legitimate Waitlist insert, then release it before promotion; do
    // not disable the False Waitlist trigger to create this fixture.
    const item=timedOffer(20100+prep,"2027-11-07T08:15:00Z","America/Vancouver",true);
    try{
      expect(item.token).toBeNull();expect(state(item.entry)).toMatchObject({status:"waiting",receipts:0,bookings:0});
      expect(sql<string>(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}';
        SELECT to_json(outcome) FROM public.evaluate_individual_waitlist_capacity('${salon}','${service}','${staff}',
          '2027-11-07','1:15 AM'); COMMIT`)).toBe("slot_available");
    }
    finally{finishTimedFixture(item.entry);}
  });
  it.each(["nonexistent_label","timezone_changed","wrong_date","seconds_precision","buffer_crosses_midnight","prep_crosses_midnight"])(
    "fails closed for stale time metadata: %s",async(scenario)=>{
      const index=["nonexistent_label","timezone_changed","wrong_date","seconds_precision","buffer_crosses_midnight","prep_crosses_midnight"].indexOf(scenario);
      const n=20200+index*10,start=scenario==="buffer_crosses_midnight"?"2027-02-15T07:15:00Z":
        scenario==="prep_crosses_midnight"?"2027-02-16T08:05:00Z":"2027-03-14T10:15:00Z";
      const item=timedOffer(n,start);
      try{
        expect(item.token).toMatch(/^[0-9a-f-]{36}$/u);
        if(scenario==="nonexistent_label")execute(`UPDATE public.booking_waitlist_entries SET preferred_slot_label='2:15 AM' WHERE id='${item.entry}'`);
        else if(scenario==="timezone_changed")execute(`UPDATE public.salons SET timezone='America/Toronto' WHERE id='${salon}'`);
        else if(scenario==="wrong_date")execute(`UPDATE public.booking_waitlist_entries SET booking_date=booking_date+1 WHERE id='${item.entry}'`);
        else if(scenario==="seconds_precision")execute(`UPDATE public.booking_waitlist_entries SET offered_start_utc=offered_start_utc+interval '30 seconds',
          offered_end_utc=offered_end_utc+interval '30 seconds' WHERE id='${item.entry}'`);
        else if(scenario==="prep_crosses_midnight")execute(`UPDATE public.services SET prep_minutes=10 WHERE id='${service}'`);
        else execute(`UPDATE public.services SET buffer_minutes=45 WHERE id='${service}'`);
        expect(await claimWaitlistSlot(item.token!,uuid(n+3000))).toEqual({ok:false,reason:"unavailable"});
        expect(state(item.entry)).toMatchObject({status:"waiting",booked_booking_id:null,receipts:1});
        expect(sql<number>(`SELECT to_json(count(*)) FROM public.bookings WHERE id=(SELECT booked_booking_id
          FROM public.booking_waitlist_entries WHERE id='${item.entry}')`)).toBe(0);
        expect(await claimWaitlistSlot(item.token!,uuid(n+3000))).toEqual({ok:false,reason:"unavailable"});
        expect(state(item.entry).receipts).toBe(1);
      }finally{finishTimedFixture(item.entry);}
  });
  it("still books a late slot whose trailing buffer fits the same business date",async()=>{
    execute(`UPDATE public.services SET buffer_minutes=15 WHERE id='${service}'`);
    const item=timedOffer(20300,"2027-02-17T07:00:00Z");
    try{
      expect(item.token).toMatch(/^[0-9a-f-]{36}$/u);
      expect(await claimWaitlistSlot(item.token!,uuid(23300))).toEqual({ok:true,outcome:"booked"});
      expect(sql<boolean>(`SELECT to_json(b.start_time_utc='2027-02-17T07:00:00Z'::timestamptz
        AND b.end_time_utc='2027-02-17T07:45:00Z'::timestamptz)
        FROM public.bookings b JOIN public.booking_waitlist_entries w ON w.booked_booking_id=b.id WHERE w.id='${item.entry}'`)).toBe(true);
      expect(state(item.entry).receipts).toBe(1);
    }finally{finishTimedFixture(item.entry);}
  });
  it.each([
    {n:20400,scenario:"nonexistent",date:"2027-03-14",label:"2:15 AM",open:"00:00",close:"23:59",duration:30,prep:0,buffer:0,outcome:"availability_unverified"},
    // Canonical public booking allows cleanup after close. Claim offers have
    // a separate same-business-day guard tested above; do not invent a stricter
    // shared admission rule that would create a False Waitlist.
    {n:20410,scenario:"buffer_midnight",date:"2027-02-20",label:"11:15 PM",open:"00:00",close:"23:59",duration:30,prep:0,buffer:45,outcome:"slot_available"},
    {n:20420,scenario:"prep_open",date:"2027-02-21",label:"9:00 AM",open:"09:00",close:"18:00",duration:30,prep:10,buffer:0,outcome:"slot_unavailable"},
    {n:20430,scenario:"spring_close",date:"2027-03-14",label:"1:45 AM",open:"00:00",close:"03:00",duration:30,prep:0,buffer:0,outcome:"slot_unavailable"},
    {n:20440,scenario:"fall_fits",date:"2027-11-07",label:"12:45 AM",open:"00:00",close:"02:30",duration:120,prep:0,buffer:0,outcome:"slot_available"},
    {n:20450,scenario:"spring_empty_day",date:"2027-03-14",label:null,open:"01:45",close:"03:00",duration:30,prep:0,buffer:0,outcome:"slot_unavailable"},
    {n:20460,scenario:"prep_staff",date:"2027-04-20",label:"12:00 PM",open:"00:00",close:"23:59",duration:30,prep:10,buffer:0,outcome:"slot_unavailable"},
    {n:20470,scenario:"prep_resource",date:"2027-04-21",label:"12:00 PM",open:"00:00",close:"23:59",duration:30,prep:10,buffer:0,outcome:"slot_unavailable"},
    {n:20480,scenario:"prep_shift",date:"2027-04-22",label:"12:00 PM",open:"00:00",close:"23:59",duration:30,prep:5,buffer:0,outcome:"slot_unavailable"},
    {n:20490,scenario:"prep_break",date:"2027-04-23",label:"12:00 PM",open:"00:00",close:"23:59",duration:30,prep:10,buffer:0,outcome:"slot_unavailable"},
    {n:20500,scenario:"spring_scan",date:"2027-03-14",label:null,open:"01:45",close:"04:00",duration:30,prep:0,buffer:0,outcome:"slot_available"},
  ])("uses real occupancy for shared capacity $scenario",({n,scenario,date,label,open,close,duration,prep,buffer,outcome})=>{
    if(scenario==="prep_break"){
      // Breaks recur weekly: isolate this staff member from retained bookings
      // on other Fridays. Roll back the entire fixture instead of bypassing
      // break-over-booking or atomic-offboarding safeguards during cleanup.
      const result=sql<{outcome:string;slot:string|null}>(`BEGIN;
        SET LOCAL request.jwt.claims='{"role":"service_role"}';
        UPDATE public.services SET duration_minutes=${duration},prep_minutes=${prep},buffer_minutes=${buffer} WHERE id='${service}';
        UPDATE public.salons SET opening_hours=(SELECT jsonb_object_agg(day,
          jsonb_build_object('open','${open}','close','${close}','closed',false))
          FROM unnest(ARRAY['sun','mon','tue','wed','thu','fri','sat']) AS day) WHERE id='${salon}';
        INSERT INTO public.staff(id,salon_id,name,status)
          VALUES('${uuid(n+1)}','${salon}','Synthetic isolated break staff','active');
        INSERT INTO public.staff_shifts(id,staff_id,salon_id,day_of_week,start_time,end_time,is_active,break_start_time,break_end_time)
          VALUES('${uuid(n)}','${uuid(n+1)}','${salon}',lower(to_char('${date}'::date,'dy')),'09:00','18:00',true,'11:45','11:55');
        SELECT json_build_object('outcome',outcome,'slot',slot_label) FROM public.evaluate_individual_waitlist_capacity(
          '${salon}','${service}','${uuid(n+1)}','${date}','${label}');
        ROLLBACK`);
      expect(result.outcome).toBe(outcome);
      expect(sql<number>(`SELECT to_json(count(*)) FROM public.staff WHERE id='${uuid(n+1)}'`)).toBe(0);
      expect(sql<number>(`SELECT to_json(count(*)) FROM public.staff_shifts WHERE id='${uuid(n)}'`)).toBe(0);
      return;
    }
    execute(`UPDATE public.services SET duration_minutes=${duration},prep_minutes=${prep},buffer_minutes=${buffer} WHERE id='${service}';
      UPDATE public.salons SET opening_hours=(SELECT jsonb_object_agg(day,jsonb_build_object('open','${open}','close','${close}','closed',false))
        FROM unnest(ARRAY['sun','mon','tue','wed','thu','fri','sat']) AS day),resources_enabled=${scenario==="prep_staff"?"false":"true"}
        WHERE id='${salon}'`);
    try{
      if(["prep_staff","prep_resource","spring_scan"].includes(scenario))execute(`INSERT INTO public.bookings(
        id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents)
        VALUES('${uuid(n)}','${salon}','${service}','${scenario==="prep_resource"?otherStaff:staff}',${scenario==="prep_staff"?"NULL":`'${bed}'`},
          'Synthetic capacity blocker','+16045550403',
          '${scenario==="spring_scan"?"2027-03-14T09:45:00Z":date+"T18:35:00Z"}'::timestamptz,
          '${scenario==="spring_scan"?"2027-03-14T10:15:00Z":date+"T18:55:00Z"}'::timestamptz,'confirmed',2500)`);
      if(scenario==="prep_shift"||scenario==="prep_break")execute(`INSERT INTO public.staff_shifts(
        id,staff_id,salon_id,day_of_week,start_time,end_time,is_active,break_start_time,break_end_time)
        VALUES('${uuid(n)}','${staff}','${salon}',lower(to_char('${date}'::date,'dy')),
          '${scenario==="prep_shift"?"12:00":"09:00"}','18:00',true,
          ${scenario==="prep_break"?"'11:45'":"NULL"},${scenario==="prep_break"?"'11:55'":"NULL"})`);
      const result=sql<{outcome:string;slot:string|null}>(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}';
        SELECT json_build_object('outcome',outcome,'slot',slot_label) FROM public.evaluate_individual_waitlist_capacity(
          '${salon}','${service}','${staff}','${date}',${label===null?"NULL":`'${label}'`}); COMMIT`);
      expect(result.outcome).toBe(outcome);
      if(scenario==="spring_scan")expect(result.slot).toBe("3:15 AM");
      if(scenario==="fall_fits")expect(result.slot).toBe("12:45 AM");
    }finally{execute(`UPDATE public.bookings SET status='cancelled' WHERE id='${uuid(n)}';
      DELETE FROM public.staff_shifts WHERE id='${uuid(n)}';
      UPDATE public.services SET duration_minutes=30,prep_minutes=0,buffer_minutes=0 WHERE id='${service}';
      UPDATE public.salons SET resources_enabled=true,opening_hours=(SELECT jsonb_object_agg(day,
        jsonb_build_object('open','00:00','close','23:59','closed',false)) FROM unnest(ARRAY['sun','mon','tue','wed','thu','fri','sat']) AS day) WHERE id='${salon}'`);}
  });
  it.each(["12:00 PM","2:15 AM"])("server rescue does not insert for available or nonexistent preferred time %s",(label)=>{
    const n=label==="12:00 PM"?20600:20610;
    const result=sql<{id:string|null;outcome:string}>(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}';
      SELECT json_build_object('id',id,'outcome',guard_outcome) FROM public.create_public_capacity_rescue_request_v2(
        '${salon}','${uuid(n)}','individual','${service}',NULL,'2027-03-14','${label}',1,
        'Synthetic rescue guest','+16045550406','rescue@example.invalid','en',
        jsonb_build_object('serviceIds',jsonb_build_array('${service}'),'staffPreference','any','source','slot_unavailable'),NULL); COMMIT`);
    expect(result).toEqual({id:null,outcome:label==="12:00 PM"?"slot_available":"availability_unverified"});
    expect(sql<number>(`SELECT to_json(count(*)) FROM public.booking_waitlist_entries WHERE request_id='${uuid(n)}'`)).toBe(0);
  });
  it.each([
    {n:20700,scenario:"missing_day",day:null},
    {n:20710,scenario:"scalar_day",day:"invalid"},
    {n:20720,scenario:"malformed_open",day:{open:"wrong",close:"18:00",closed:false}},
    {n:20730,scenario:"missing_close",day:{open:"09:00",closed:false}},
    {n:20740,scenario:"missing_closed",day:{open:"09:00",close:"18:00"}},
    {n:20750,scenario:"string_closed",day:{open:"09:00",close:"18:00",closed:"false"}},
  ])("does not admit a Waitlist when opening truth is $scenario",({n,day})=>{
    const date="2027-04-28";
    const hours=day===null?{}:{wed:day};
    execute(`UPDATE public.salons SET opening_hours='${JSON.stringify(hours)}'::jsonb WHERE id='${salon}'`);
    try{
      const result=sql<{id:string|null;outcome:string}>(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}';
        SELECT json_build_object('id',id,'outcome',guard_outcome) FROM public.create_public_capacity_rescue_request_v2(
          '${salon}','${uuid(n)}','individual','${service}',NULL,'${date}','12:00 PM',1,
          'Synthetic config guest','+16045550407','config@example.invalid','en',
          jsonb_build_object('serviceIds',jsonb_build_array('${service}'),'staffPreference','any','source','slot_unavailable'),NULL); COMMIT`);
      expect(result).toEqual({id:null,outcome:"availability_unverified"});
      expect(sql<number>(`SELECT to_json(count(*)) FROM public.booking_waitlist_entries WHERE request_id='${uuid(n)}'`)).toBe(0);
    }finally{execute(`UPDATE public.booking_waitlist_entries SET status='expired' WHERE request_id='${uuid(n)}';
      UPDATE public.salons SET opening_hours=(SELECT jsonb_object_agg(day,
        jsonb_build_object('open','00:00','close','23:59','closed',false)) FROM unnest(ARRAY['sun','mon','tue','wed','thu','fri','sat']) AS day) WHERE id='${salon}'`);}
  });
  it("preserves an explicitly closed salon day as proven unavailable",()=>{
    execute(`UPDATE public.salons SET opening_hours='{"wed":{"closed":true}}'::jsonb WHERE id='${salon}'`);
    try{expect(sql<string>(`BEGIN; SET LOCAL request.jwt.claims='{"role":"service_role"}';
      SELECT to_json(outcome) FROM public.evaluate_individual_waitlist_capacity('${salon}','${service}',NULL,'2027-04-28','12:00 PM');COMMIT`)).toBe("slot_unavailable");}
    finally{execute(`UPDATE public.salons SET opening_hours=(SELECT jsonb_object_agg(day,
      jsonb_build_object('open','00:00','close','23:59','closed',false)) FROM unnest(ARRAY['sun','mon','tue','wed','thu','fri','sat']) AS day) WHERE id='${salon}'`);}
  });
  it.each([
    {n:20800,date:"2027-04-29",label:"5:30 PM",start:"2027-04-30T00:30:00Z",close:"18:00",buffer:10},
    {n:20810,date:"2027-04-30",label:"11:15 PM",start:"2027-05-01T06:15:00Z",close:"23:59",buffer:45},
  ])("keeps customer completion versus cleanup parity at $label on $date",({n,date,label,start,close,buffer})=>{
    execute(`UPDATE public.services SET buffer_minutes=${buffer} WHERE id='${service}';
      UPDATE public.salons SET opening_hours=(SELECT jsonb_object_agg(day,
        jsonb_build_object('open','09:00','close','${close}','closed',false)) FROM unnest(ARRAY['sun','mon','tue','wed','thu','fri','sat']) AS day) WHERE id='${salon}'`);
    try{
      const actual=sql<{success:boolean;code:string}>(`BEGIN;SET LOCAL request.jwt.claims='{"role":"service_role"}';
        WITH result AS (SELECT public.create_public_booking('${salon}','${service}','${staff}',
          'Synthetic closing guest','+16045550408','${start}'::timestamptz,
          '${start}'::timestamptz+make_interval(mins=>30+${buffer}),'confirmed',2500,NULL,NULL,NULL,NULL,'${bed}') AS body)
        SELECT json_build_object('success',body->'success','code',body->>'code') FROM result;COMMIT`);
      expect(actual.success).toBe(true);
      const saved=sql<{buffered:boolean}>(`SELECT json_build_object('buffered',end_time_utc='${start}'::timestamptz+make_interval(mins=>30+${buffer}))
        FROM public.bookings WHERE salon_id='${salon}' AND client_name='Synthetic closing guest' AND start_time_utc='${start}'::timestamptz`);
      expect(saved.buffered).toBe(true);
      execute(`UPDATE public.bookings SET status='cancelled' WHERE salon_id='${salon}' AND client_name='Synthetic closing guest' AND start_time_utc='${start}'::timestamptz`);
      const capacity=sql<string>(`BEGIN;SET LOCAL request.jwt.claims='{"role":"service_role"}';
        SELECT to_json(outcome) FROM public.evaluate_individual_waitlist_capacity('${salon}','${service}',NULL,'${date}','${label}');COMMIT`);
      expect(capacity).toBe("slot_available");
      const admission=sql<{id:string|null;outcome:string}>(`BEGIN;SET LOCAL request.jwt.claims='{"role":"service_role"}';
        SELECT json_build_object('id',id,'outcome',guard_outcome) FROM public.create_public_capacity_rescue_request_v2(
          '${salon}','${uuid(n)}','individual','${service}',NULL,'${date}','${label}',1,
          'Synthetic closing guest','+16045550408','closing@example.invalid','en',
          jsonb_build_object('serviceIds',jsonb_build_array('${service}'),'staffPreference','any','source','slot_unavailable'),NULL);COMMIT`);
      expect(admission).toEqual({id:null,outcome:"slot_available"});
    }finally{execute(`UPDATE public.bookings SET status='cancelled' WHERE salon_id='${salon}' AND client_name='Synthetic closing guest' AND start_time_utc='${start}'::timestamptz;
      UPDATE public.booking_waitlist_entries SET status='expired' WHERE request_id='${uuid(n)}';
      UPDATE public.services SET buffer_minutes=0 WHERE id='${service}';
      UPDATE public.salons SET opening_hours=(SELECT jsonb_object_agg(day,
        jsonb_build_object('open','00:00','close','23:59','closed',false)) FROM unnest(ARRAY['sun','mon','tue','wed','thu','fri','sat']) AS day) WHERE id='${salon}'`);}
  });
  it.each([
    {n:20900,scenario:"one_busy",available:true},
    {n:20910,scenario:"all_busy",available:false},
    {n:20920,scenario:"all_staff_absent",available:false},
    {n:20930,scenario:"specific_busy",available:false},
    {n:20940,scenario:"all_day_full",available:false},
    {n:20950,scenario:"all_resources_busy",available:false},
    {n:20960,scenario:"slot_taken_before_submit",available:false},
    {n:20970,scenario:"slot_released_before_submit",available:true},
  ])("revalidates seven eligible staff and seven beds for $scenario",({n,scenario,available})=>{
    const date="2027-05-20",start="2027-05-20T21:00:00Z";
    const staffIds=[staff,otherStaff,...Array.from({length:5},(_,i)=>uuid(21000+i))];
    const bedIds=[bed,...Array.from({length:6},(_,i)=>uuid(21100+i))];
    const staffSql=staffIds.map(id=>`'${id}'`).join(",");
    execute(`INSERT INTO public.staff(id,salon_id,name,status) VALUES ${staffIds.slice(2).map((id,i)=>`('${id}','${salon}','Synthetic seven staff ${i}','active')`).join(",")}
      ON CONFLICT(id) DO UPDATE SET status='active';
      INSERT INTO public.salon_resources(id,salon_id,name,kind,status) VALUES ${bedIds.slice(1).map((id,i)=>`('${id}','${salon}','Synthetic seven bed ${i}','bed','active')`).join(",")}
      ON CONFLICT(id) DO UPDATE SET status='active';
      INSERT INTO public.staff_services(staff_id,service_id) VALUES ${staffIds.map(id=>`('${id}','${service}')`).join(",")}
        ON CONFLICT(staff_id,service_id) DO NOTHING;
      UPDATE public.services SET duration_minutes=80 WHERE id='${service}';
      UPDATE public.salons SET opening_hours=(SELECT jsonb_object_agg(day,
        jsonb_build_object('open','14:00','close','${scenario==="all_day_full"?"15:20":"18:00"}','closed',false))
        FROM unnest(ARRAY['sun','mon','tue','wed','thu','fri','sat']) AS day) WHERE id='${salon}'`);
    try{
      expect(sql<number>(`SELECT to_json(count(*)) FROM public.staff_services WHERE staff_id IN (${staffSql}) AND service_id='${service}'`)).toBe(7);
      const supportStaff=Array.from({length:7},(_,i)=>uuid(21200+i));
      if(scenario==="all_resources_busy")execute(`INSERT INTO public.staff(id,salon_id,name,status)
        VALUES ${supportStaff.map((id,i)=>`('${id}','${salon}','Synthetic other-service staff ${i}','active')`).join(",")};
        INSERT INTO public.staff_services(staff_id,service_id) VALUES ${supportStaff.map(id=>`('${id}','${uuid(6)}')`).join(",")};
        UPDATE public.services SET duration_minutes=80,resource_requirement_mode='specific',required_resource_kinds=ARRAY['bed']
        WHERE id='${uuid(6)}'`);
      const evaluate=()=>sql<{outcome:string;eligibleStaff:number;eligibleBeds:number;freeStaff:number;freeBeds:number}>(
        `BEGIN;SET LOCAL request.jwt.claims='{"role":"service_role"}';SELECT json_build_object('outcome',outcome,
          'eligibleStaff',eligible_staff_count,'eligibleBeds',eligible_resource_count,'freeStaff',free_staff_count,'freeBeds',free_resource_count)
          FROM public.evaluate_individual_waitlist_capacity('${salon}','${service}',NULL,'${date}','2:00 PM');COMMIT`);
      if(scenario==="slot_taken_before_submit")expect(evaluate()).toMatchObject({outcome:"slot_available",freeStaff:7,freeBeds:7});
      const total=["all_busy","all_day_full","all_resources_busy","slot_taken_before_submit","slot_released_before_submit"].includes(scenario)?7:scenario==="all_staff_absent"?0:1;
      for(let i=0;i<total;i++){
        const result=sql<{success:boolean}>(`BEGIN;SET LOCAL request.jwt.claims='{"role":"service_role"}';
          WITH result AS (SELECT public.create_public_booking('${salon}','${scenario==="all_resources_busy"?uuid(6):service}','${scenario==="all_resources_busy"?supportStaff[i]:staffIds[i]}',
            'Synthetic seven blocker','+1604555${String(500+(n-20900)/10*7+i).padStart(4,"0")}','${start}'::timestamptz,'${start}'::timestamptz+interval '80 minutes',
            'confirmed',${scenario==="all_resources_busy"?1000:2500},NULL,NULL,NULL,NULL,'${bedIds[i]}') AS body)
          SELECT json_build_object('success',body->'success') FROM result;COMMIT`);
        expect(result.success).toBe(true);
      }
      if(scenario==="slot_released_before_submit"){
        expect(evaluate()).toMatchObject({outcome:"slot_unavailable",freeStaff:0,freeBeds:0});
        execute(`UPDATE public.bookings SET status='cancelled' WHERE salon_id='${salon}'
          AND client_name='Synthetic seven blocker' AND start_time_utc='${start}'::timestamptz`);
      }
      if(scenario==="all_staff_absent")execute(`INSERT INTO public.staff_unavailability(staff_id,salon_id,date,reason)
        VALUES ${staffIds.map(id=>`('${id}','${salon}','${date}','Synthetic seven absence')`).join(",")}`);
      const requested=scenario==="specific_busy"?`'${staff}'`:"NULL";
      const label=scenario==="all_day_full"?"NULL":"'2:00 PM'";
      const capacity=sql<{outcome:string;eligibleStaff:number;eligibleBeds:number;freeStaff:number;freeBeds:number}>(
        `BEGIN;SET LOCAL request.jwt.claims='{"role":"service_role"}';SELECT json_build_object('outcome',outcome,
          'eligibleStaff',eligible_staff_count,'eligibleBeds',eligible_resource_count,'freeStaff',free_staff_count,'freeBeds',free_resource_count)
          FROM public.evaluate_individual_waitlist_capacity('${salon}','${service}',${requested},'${date}',${label});COMMIT`);
      expect(capacity.outcome).toBe(available?"slot_available":"slot_unavailable");
      expect(capacity.eligibleStaff).toBe(scenario==="specific_busy"?1:7);
      expect(capacity.eligibleBeds).toBe(7);
      if(available)expect(capacity).toMatchObject({freeStaff:scenario==="slot_released_before_submit"?7:6,freeBeds:scenario==="slot_released_before_submit"?7:6});
      if(scenario==="all_staff_absent")expect(capacity).toMatchObject({freeStaff:0,freeBeds:7});
      if(scenario==="all_resources_busy")expect(capacity).toMatchObject({freeStaff:7,freeBeds:0});
      const admission=()=>sql<{id:string|null;created:boolean;outcome:string}>(`BEGIN;SET LOCAL request.jwt.claims='{"role":"service_role"}';
        SELECT json_build_object('id',id,'created',created_new,'outcome',guard_outcome) FROM public.create_public_capacity_rescue_request_v2(
          '${salon}','${uuid(n)}','individual','${service}',${requested},'${date}',${label},1,
          'Synthetic seven waiter','+16045550410','seven@example.invalid','en',
          jsonb_build_object('serviceIds',jsonb_build_array('${service}'),'staffPreference','${scenario==="specific_busy"?staff:"any"}',
            'source','${scenario==="slot_taken_before_submit"?"booking_conflict":"slot_unavailable"}'),NULL);COMMIT`);
      const first=admission();
      expect(first.outcome).toBe(capacity.outcome);
      if(available)expect(first).toEqual({id:null,created:false,outcome:"slot_available"});
      else{expect(first.created).toBe(true);expect(first.id).toMatch(/^[0-9a-f-]{36}$/u);}
      // Committed admission retries must replay the same entry, not create a
      // duplicate. A rejected available request has no entry to replay.
      const retried=admission();
      expect(retried).toEqual({...first,created:false});
      expect(sql<number>(`SELECT to_json(count(*)) FROM public.booking_waitlist_entries WHERE request_id='${uuid(n)}'`)).toBe(available?0:1);
      if(scenario==="slot_taken_before_submit")expect(sql<string>(`SELECT to_json(source) FROM public.booking_waitlist_entries
        WHERE request_id='${uuid(n)}'`)).toBe("booking_conflict");
    }finally{execute(`UPDATE public.bookings SET status='cancelled' WHERE salon_id='${salon}'
        AND client_name='Synthetic seven blocker' AND start_time_utc='${start}'::timestamptz;
      UPDATE public.booking_waitlist_entries SET status='expired' WHERE request_id='${uuid(n)}';
      DELETE FROM public.staff_unavailability WHERE salon_id='${salon}' AND date='${date}' AND staff_id IN (${staffSql});
      UPDATE public.services SET duration_minutes=30 WHERE id='${service}';
      UPDATE public.services SET duration_minutes=15,resource_requirement_mode='salon_default',required_resource_kinds=ARRAY[]::text[] WHERE id='${uuid(6)}';
      UPDATE public.salons SET opening_hours=(SELECT jsonb_object_agg(day,
        jsonb_build_object('open','00:00','close','23:59','closed',false)) FROM unnest(ARRAY['sun','mon','tue','wed','thu','fri','sat']) AS day)
        WHERE id='${salon}'`);}
  });
});

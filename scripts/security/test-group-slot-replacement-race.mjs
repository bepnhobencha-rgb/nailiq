/** Local disposable database ONLY; no HTTP/provider access. */
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const docker = ['--context','colima-nailiq-p0-503','exec','supabase_db_nailiq-day5-20260924','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','nailiq_fee_final_acceptance_20260925','-c'];
const sql = (q) => execFileSync('docker',[...docker,q],{encoding:'utf8'}).trim();
const asyncSql = async(q) => (await promisify(execFile)('docker',[...docker,q],{encoding:'utf8'})).stdout.trim();
const q = (value) => `'${String(value).replaceAll("'","''")}'`;
const salon=randomUUID(),service=randomUUID(),staff=randomUUID(),group=randomUUID();
sql(`INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code,profile_complete,noshow_protection_enabled,feature_flags) VALUES(${q(salon)},${q(`e2e-group-race-${salon}`)},'E2E Group Race','16045550100','America/Vancouver','CAD',true,false,'{"group_slot_recovery_v1":true}');
INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('group-recovery-test','Synthetic','Synthetic') ON CONFLICT DO NOTHING;
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category) VALUES(${q(service)},${q(salon)},'Synthetic',5000,30,'group-recovery-test');
INSERT INTO public.staff(id,salon_id,name,status) VALUES(${q(staff)},${q(salon)},'Synthetic','active');`);
async function fixture(i) {
 const booking=randomUUID(),request=randomUUID(),hash=createHash('sha256').update(randomUUID()).digest('hex');
 sql(`INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,attendance_status,price_cents,group_id,group_size,is_party_member) VALUES(${q(booking)},${q(salon)},${q(service)},${q(staff)},'Synthetic Original','16045550000',now()+interval '5 days ${i} hours',now()+interval '5 days ${i} hours 30 minutes','confirmed','confirmed',5000,${q(group)},3,true);`);
 const cap=JSON.parse(sql(`SELECT public.mint_booking_management_capability(${q(salon)},${q(booking)},'cancel',now()+interval '2 hours')`)).token_id;
 assert.equal(JSON.parse(sql(`SELECT public.start_group_slot_replacement(${q(cap)},${q(randomUUID())},${q(hash)})`)).ok,true);
 return {booking,cap,request,hash};
}
function accept(f,request=f.request,phone='16045550123') { return `SELECT public.accept_group_slot_replacement(${q(f.hash)},${q(request)},'Synthetic Replacement',${q(phone)},true)`; }
const a=await fixture(1);
const same=await Promise.all(Array.from({length:20},()=>asyncSql(accept(a))));
assert.equal(same.filter(v=>JSON.parse(v).ok).length,20);
assert.equal(same.filter(v=>JSON.parse(v).idempotent===false).length,1);
const b=await fixture(2);
const different=await Promise.all(Array.from({length:20},(_,i)=>asyncSql(accept(b,randomUUID(),`1604555${String(2000+i)}`))));
assert.equal(different.filter(v=>JSON.parse(v).ok).length,1);
const c=await fixture(3);
const mixed=await Promise.all([asyncSql(accept(c,randomUUID(),'16045550998')),asyncSql(`SELECT public.revoke_group_slot_replacement(${q(c.cap)},${q(randomUUID())})`)]);
const ledger=JSON.parse(sql(`SELECT jsonb_build_object('status',r.status,'original',b.status,'replacement',r.replacement_booking_id) FROM public.group_slot_replacements r JOIN public.bookings b ON b.id=r.original_booking_id WHERE r.original_booking_id=${q(c.booking)}`));
assert.ok(ledger.status==='accepted' ? ledger.original==='cancelled'&&ledger.replacement : ledger.status==='revoked'&&ledger.original==='confirmed'&&!ledger.replacement);
assert.equal(sql(`SELECT count(*) FROM public.booking_payment_operations WHERE salon_id=${q(salon)}`),'0');
assert.equal(sql(`SELECT count(*) FROM public.owner_booking_notification_outbox WHERE salon_id=${q(salon)}`),'0');
console.log(JSON.stringify({sameRequest20:'PASS one mutation, 19 replays',differentRequest20:'PASS one winner',acceptVersusRevoke:'PASS atomic winner',paymentOperations:0,ownerNotifications:0,fixtureSalonId:salon,mixedOutcomes:mixed.map(v=>JSON.parse(v).ok)}));

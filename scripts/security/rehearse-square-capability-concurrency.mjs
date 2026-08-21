#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const runFile=promisify(execFile); const url=process.env.DB_URL; const psql=process.env.PSQL_BIN??"psql";
if(process.env.NAILIQ_DISPOSABLE_DB!=="1"||!url) throw new Error("disposable local DB required");
const host=new URL(url).hostname; if(!["","localhost","127.0.0.1","[::1]","::1"].includes(host)) throw new Error("non-local DB refused");
const run=async(sql)=>(await runFile(psql,[url,"-X","-v","ON_ERROR_STOP=1","-Atq","-c",sql],{encoding:"utf8",timeout:30000})).stdout.trim();
const salon="51250000-0000-4000-8000-000000000001",request="51250000-0000-4000-8000-000000000002";
try{
 await run(`delete from public.salons where id='${salon}'; insert into public.salons(id,slug,name,phone,timezone,currency_code) values('${salon}','square-cap-race','Square cap race','+16045550125','UTC','CAD'); insert into public.square_integrations(salon_id,merchant_id,location_id,application_id,access_token,environment,oauth_scopes,inventory_sync_enabled) values('${salon}','merchant_race','location_race','application_race','secret','sandbox',array['INVENTORY_READ','INVENTORY_WRITE','ITEMS_READ'],true); insert into public.platform_settings(id) values('platform') on conflict(id) do nothing; update public.platform_settings set square_inventory_platform_enabled=true where id='platform';`);
 const requestJson=`'{"source_id":"variation_race","quantity":"1.5","from_state":"IN_STOCK","to_state":"SOLD"}'::jsonb`;
 const fp=await run(`select set_config('request.jwt.claim.role','service_role',true); select public.resolve_square_feature_operation_material('${salon}','inventory_adjustment',${requestJson})->>'material_fingerprint'`); const hash=fp.split("\n").at(-1);
 const claim=`select set_config('request.jwt.claim.role','service_role',true); select public.claim_square_feature_operation('${salon}','${request}','inventory_adjustment',${requestJson},'${hash}')::text`;
 const [a,b]=await Promise.all([run(claim),run(claim)]); const rows=[a,b].map(x=>JSON.parse(x.split("\n").at(-1)));
 assert.equal(await run(`select count(*) from public.square_feature_operations where salon_id='${salon}' and request_id='${request}'`),"1");
 assert.equal(new Set(rows.map(x=>x.operation_id)).size,1); assert.equal(rows.filter(x=>x.code==="operation_claimed").length,1);
 const account=await run(`select provider_account_fingerprint from public.square_feature_operations where salon_id='${salon}'`);
 const material=`jsonb_build_object('merchant_id','merchant_race','application_id','application_race','environment','sandbox','api_version','2026-07-15','provider_account_fingerprint','${account}','counts',jsonb_build_array(jsonb_build_object('catalog_object_type','ITEM_VARIATION','catalog_object_id','variation_race','location_id','location_race','quantity','4.25','state','IN_STOCK')))`;
 const event=`select set_config('request.jwt.claim.role','service_role',true); select public.record_square_webhook_event('${salon}','event_race','inventory.count.updated','2026-08-20Z','variation_race',${material},repeat('a',64))::text`;
 const [e1,e2]=await Promise.all([run(event),run(event)]); assert.deepEqual(new Set([JSON.parse(e1.split("\n").at(-1)).code,JSON.parse(e2.split("\n").at(-1)).code]),new Set(["event_recorded","event_replay"]));
 assert.equal(await run(`select count(*) from public.square_webhook_inbox where provider_account_fingerprint='${account}' and event_id='event_race'`),"1");
 console.log("square capability concurrency passed");
}finally{await run(`delete from public.salons where id='${salon}'; update public.platform_settings set square_inventory_platform_enabled=false where id='platform';`).catch(()=>{});}

import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { chargeSavedCard, findExactSquarePaymentByReference, type SquareConfig } from "../../src/shared/integrations/square/client";

// Separate from the existing card-only guard: that guard must never allow
// payments. Credentials and all run artifacts stay outside this repository.
if (process.env.NAILIQ_FEE_SANDBOX_QA !== "1" || process.env.NAILIQ_QA_SQUARE_ENVIRONMENT !== "sandbox") {
  throw new Error("explicit_fee_sandbox_opt_in_required");
}
if ([process.env.DISABLE_OUTBOUND_SMS, process.env.DISABLE_OUTBOUND_EMAIL, process.env.DISABLE_OUTBOUND_CALLS].some(value => value !== "1")) {
  throw new Error("outbound_must_be_disabled");
}
const notificationMode = process.env.NAILIQ_QA_SQUARE_NOTIFICATION_MODE ?? "off_required";
if (notificationMode !== "off_required" && notificationMode !== "test_notifications_authorized") throw new Error("notification_mode_invalid");
if (notificationMode === "off_required" && process.env.NAILIQ_QA_SQUARE_NOTIFICATIONS_OFF_VERIFIED !== "1") throw new Error("notifications_off_unproven");
const credentialsPath = process.env.NAILIQ_QA_SQUARE_CREDENTIALS_FILE;
const evidenceDirectory = process.env.NAILIQ_QA_FEE_EVIDENCE_DIRECTORY;
const repository = fs.realpathSync(process.cwd());
if (!fs.existsSync(path.join(repository,"scripts/qa/square-saved-card-fee-sandbox.ts"))) throw new Error("run_from_repository_root");
function outsideRepository(value: string | undefined): string {
  if (!value || !path.isAbsolute(value)) throw new Error("absolute_external_path_required");
  const real = fs.realpathSync(value);
  if (real === repository || real.startsWith(repository + path.sep)) throw new Error("external_path_required");
  return real;
}
const credentialsFile = outsideRepository(credentialsPath);
const evidenceRoot = outsideRepository(evidenceDirectory);
if (!fs.statSync(credentialsFile).isFile() || !fs.statSync(evidenceRoot).isDirectory()) throw new Error("evidence_path_invalid");
if ((fs.statSync(credentialsFile).mode & 0o077) !== 0) throw new Error("credentials_permissions_must_be_private");
const run = randomUUID();
const reportPath = path.join(evidenceRoot, `square-fee-sandbox-${run}.json`);
const journalPath = path.join(evidenceRoot, `square-fee-sandbox-${run}.journal.jsonl`);
const journal = fs.openSync(journalPath, "wx", 0o600);
let raw: Record<string,string>;
try { raw = JSON.parse(fs.readFileSync(credentialsFile, "utf8")); }
catch { throw new Error("sandbox_credentials_invalid"); }
const cfg: SquareConfig = {
  salonId: "55630000-0000-4000-8000-000000000060",
  merchantId: raw.NAILIQ_QA_SQUARE_SANDBOX_MERCHANT_ID,
  applicationId: raw.NAILIQ_QA_SQUARE_SANDBOX_APPLICATION_ID,
  locationId: raw.NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID,
  accessToken: raw["NAILIQ_QA_SQUARE_SANDBOX_ACCESS_TOKEN"],
  environment: "sandbox", currency: "CAD",
  sync: {pullCreate:false,pullUpdate:false,pullCancel:false,pushCreate:false,pushUpdate:false,pushCancel:false},
};
const origin = "https://connect.squareupsandbox.com";
const nativeFetch = globalThis.fetch;
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0,16);
const report = {
  run, environment: "sandbox", notificationMode, status: "NOT_PROVEN", productionCalls: 0,
  customerCreates: 0, cardCreates: 0, paymentPosts: 0, reads: 0,
  customerContactProvided: false, notificationEndpointsCalled: false,
  enabledWebhooks: 0, databaseCalls: 0,
  scenarios: [] as Record<string, unknown>[],
};
let armed = false;
let customerId = "";
let cardId = "";
let loseReference = "";
let lostPaymentId = "";
const keyRefs = new Map<string, string>();
const safeError = (code: string): never => { throw new Error(code); };
const headers = (token = cfg.accessToken) => ({ Authorization:`Bearer ${token}`, "Square-Version":"2024-12-18", "Content-Type":"application/json" });
function writeJournal(value: Record<string, unknown>) { fs.writeSync(journal, JSON.stringify({ at:new Date().toISOString(), ...value }) + "\n"); fs.fsyncSync(journal); }
async function read(path: string, method="GET", token=cfg.accessToken) {
  const url = new URL(path,origin);
  if (url.origin !== origin || !["/oauth2/token/status","/v2/locations","/v2/webhooks/subscriptions"].includes(url.pathname)) safeError("preflight_route_denied");
  const response = await nativeFetch(url,{method,headers:headers(token),redirect:"error",signal:AbortSignal.timeout(12000)});
  report.reads++;
  const body = await response.json();
  if (!response.ok || body.errors?.length) safeError("preflight_failed");
  return body;
}
async function preflight() {
  if(cfg.environment !== "sandbox" || !cfg.applicationId?.startsWith("sandbox-sq0idb-")) safeError("sandbox_required");
  const identity = await read("/oauth2/token/status","POST");
  if(identity.client_id !== cfg.applicationId || identity.merchant_id !== cfg.merchantId) safeError("sandbox_identity_mismatch");
  const locations = await read("/v2/locations");
  if(!locations.locations?.some((row:Record<string,unknown>) => row.id===cfg.locationId && row.merchant_id===cfg.merchantId && row.currency==="CAD" && row.status==="ACTIVE")) safeError("sandbox_location_mismatch");
  const hookToken=raw["NAILIQ_QA_SQUARE_SANDBOX_WEBHOOK_ACCESS_TOKEN"];
  const hookIdentity=await read("/oauth2/token/status","POST",hookToken);
  if(hookIdentity.client_id!==cfg.applicationId) safeError("sandbox_webhook_identity_mismatch");
  const seen = new Set<string>();
  let cursor = "";
  do {
    const hooks=await read("/v2/webhooks/subscriptions"+(cursor?"?cursor="+encodeURIComponent(cursor):""),"GET",hookToken);
    if((hooks.subscriptions??[]).some((row:Record<string,unknown>)=>row.enabled!==false)) safeError("sandbox_webhooks_enabled");
    cursor=hooks.cursor??"";
    if(cursor&&(seen.has(cursor)||seen.size>=50)) safeError("sandbox_webhooks_incomplete");
    if(cursor) seen.add(cursor);
  } while(cursor);
  armed=true;
}
globalThis.fetch = async (input,init) => {
  const req = new Request(input,init);
  const url = new URL(req.url);
  if(!armed||url.origin!==origin||url.username||url.password||req.headers.get("Authorization")!==headers().Authorization) safeError("network_boundary_denied");
  const body = req.method==="POST" ? await req.clone().json() : null;
  if(req.method==="POST" && url.pathname==="/v2/customers" && !url.search) {
    if(report.customerCreates || body.given_name!=="Synthetic Fee QA"||body.reference_id!==run||Object.keys(body).some(key=>!["given_name","reference_id","idempotency_key"].includes(key))) safeError("synthetic_customer_required");
    report.customerCreates++;
  } else if(req.method==="POST" && url.pathname==="/v2/cards" && !url.search) {
    if(report.cardCreates||!customerId||body.source_id!=="cnon:card-nonce-ok"||body.card?.customer_id!==customerId||body.card.reference_id!==run||body.card.billing_address?.postal_code!=="94103") safeError("synthetic_card_required");
    if(Object.keys(body).some(key=>!["source_id","idempotency_key","card"].includes(key))||Object.keys(body.card).some(key=>!["customer_id","reference_id","billing_address"].includes(key))||Object.keys(body.card.billing_address).some(key=>key!=="postal_code")) safeError("synthetic_card_required");
    report.cardCreates++;
  } else if(req.method==="POST" && url.pathname==="/v2/payments" && !url.search) {
    if(report.paymentPosts>=6||!customerId||body.customer_id!==customerId||![cardId,"ccof:customer-card-id-declined"].includes(body.source_id)||body.amount_money?.amount!==100||body.amount_money.currency!=="CAD"||body.location_id!==cfg.locationId||body.reference_id!==keyRefs.get(body.idempotency_key)||body.autocomplete!==true||body.customer_details?.customer_initiated!==false) safeError("synthetic_payment_required");
    if(Object.keys(body).some(key=>!["source_id","customer_id","amount_money","location_id","reference_id","idempotency_key","autocomplete","customer_details"].includes(key))) safeError("payment_body_denied");
    report.paymentPosts++;
  } else if(req.method==="GET" && url.pathname==="/v2/payments" && url.searchParams.get("location_id")===cfg.locationId) {
    report.reads++;
  } else safeError("sandbox_route_denied");
  writeJournal({phase:"dispatch",method:req.method,path:url.pathname,reference:body?.reference_id??null});
  const response=await nativeFetch(new Request(req,{redirect:"error",signal:AbortSignal.timeout(12000)}));
  if(url.pathname==="/v2/payments" && req.method==="POST" && body.reference_id===loseReference) {
    const value=await response.clone().json();
    if(response.ok&&value.payment?.status==="COMPLETED"&&typeof value.payment.id==="string") {
      lostPaymentId=value.payment.id;
      writeJournal({phase:"injected_response_loss",reference:loseReference,paymentFingerprint:hash(lostPaymentId)});
      loseReference="";
      throw new Error("synthetic_response_loss");
    }
  }
  return response;
};
async function syntheticCreate(path:string, body:Record<string,unknown>) {
  const response=await fetch(origin+path,{method:"POST",headers:headers(),body:JSON.stringify(body)});
  const json=await response.json();
  if(!response.ok||json.errors?.length) safeError("synthetic_fixture_create_failed");
  return json;
}
function options(kind:string,source=cardId) {
  const ref=randomUUID();
  const key=kind+":"+randomUUID();
  keyRefs.set(key,ref);
  return {cardId:source,customerId,amountCents:100,idempotencyKey:key,referenceId:ref};
}
async function reconcile(referenceId: string, beginTime: string, expectedId: string) {
  // Square ListPayments can briefly show APPROVED after CreatePayment returned
  // COMPLETED. Retry reads with the same reference; never replay a charge here.
  for (let attempt=0; attempt<5; attempt++) {
    if (attempt) await new Promise(resolve=>setTimeout(resolve,1000));
    try {
      const found=await findExactSquarePaymentByReference(cfg,{referenceId,amountCents:100,currency:"CAD",beginTime,endTime:new Date().toISOString()});
      if (found?.id === expectedId) return found;
      if (found) safeError("recovery_receipt_mismatch");
      writeJournal({phase:"recovery_read_empty",reference:referenceId,attempt:attempt+1});
    } catch(error) {
      // Only the known exact-receipt validation case is retried; conflicts,
      // pagination limits and network errors stop this run for inspection.
      if (!(error instanceof Error) || error.message !== "square_payment_recovery_receipt_invalid") throw error;
      writeJournal({phase:"recovery_receipt_not_ready",reference:referenceId,attempt:attempt+1});
    }
  }
  return safeError("recovery_not_proven");
}
async function main() {
  await preflight();
  const customer=await syntheticCreate("/v2/customers",{given_name:"Synthetic Fee QA",reference_id:run,idempotency_key:run});
  customerId=customer.customer?.id;
  if(!customerId) safeError("synthetic_customer_receipt_missing");
  const card=await syntheticCreate("/v2/cards",{source_id:"cnon:card-nonce-ok",idempotency_key:randomUUID(),card:{customer_id:customerId,reference_id:run,billing_address:{postal_code:"94103"}}});
  cardId=card.card?.id;
  if(!cardId||card.card.customer_id!==customerId||card.card.enabled!==true) safeError("synthetic_card_receipt_invalid");
  const success=options("success");
  const first=await chargeSavedCard(cfg,success);
  const replay=await chargeSavedCard(cfg,success);
  if(first.status!=="COMPLETED"||replay.paymentId!==first.paymentId) safeError("idempotency_failed");
  report.scenarios.push({name:"success_and_exact_replay",status:"PASS",paymentFingerprint:hash(first.paymentId),sameReceipt:true});
  const decline=options("decline","ccof:customer-card-id-declined");
  try {await chargeSavedCard(cfg,decline);safeError("decline_not_rejected");} catch(error) {
    const codes=(error as {codes?:string[]}).codes??[];
    if(!codes.includes("CARD_DECLINED")&&!codes.includes("GENERIC_DECLINE")) safeError("decline_not_proven");
    report.scenarios.push({name:"decline",status:"PASS",providerCode:codes.includes("CARD_DECLINED")?"CARD_DECLINED":"GENERIC_DECLINE"});
  }
  const loss=options("loss");
  const beginTime=new Date(Date.now()-60000).toISOString();
  loseReference=loss.referenceId;
  try {await chargeSavedCard(cfg,loss);safeError("response_loss_not_injected");} catch {
    if(!lostPaymentId) safeError("response_loss_not_proven");
  }
  const recovered=await reconcile(loss.referenceId,beginTime,lostPaymentId);
  if(recovered?.id!==lostPaymentId) safeError("recovery_not_proven");
  report.scenarios.push({name:"post_dispatch_response_loss_readonly_recovery",status:"PASS",paymentFingerprint:hash(lostPaymentId),secondPaymentPost:false});
  const race=options("race");
  const raceBeginTime=new Date(Date.now()-60000).toISOString();
  const settled=await Promise.allSettled([chargeSavedCard(cfg,race),chargeSavedCard(cfg,race)]);
  if(settled.some(result=>result.status!=="fulfilled")) safeError("race_response_unproven");
  const results=settled.flatMap(result=>result.status==="fulfilled"?[result.value]:[]);
  if(results.some(result=>result.status!=="COMPLETED"||result.paymentId!==results[0].paymentId)) safeError("race_not_idempotent");
  await reconcile(race.referenceId,raceBeginTime,results[0].paymentId);
  report.scenarios.push({name:"concurrent_same_key",status:"PASS",paymentFingerprint:hash(results[0].paymentId),sameReceipt:true,exactMatches:1});
  report.status="PASS_SANDBOX_ADAPTER";
}
main().catch(error=>{
  report.status="FAILED_OR_BLOCKED";
  const safeCodes=["synthetic_fixture_create_failed","synthetic_customer_receipt_missing","synthetic_card_receipt_invalid","idempotency_failed","decline_not_proven","response_loss_not_proven","recovery_not_proven","recovery_receipt_mismatch","race_not_idempotent","race_response_unproven","preflight_failed","sandbox_identity_mismatch","sandbox_location_mismatch","sandbox_webhook_identity_mismatch","sandbox_webhooks_enabled","sandbox_webhooks_incomplete","square_payment_receipt_invalid","square_payment_recovery_receipt_invalid"];
  Object.assign(report,{reason:safeCodes.includes(error.message)?error.message:"sandbox_test_incomplete"});
}).finally(()=>{
  writeJournal({phase:"finished",status:report.status});
  fs.closeSync(journal);
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600,flag:"wx"});
  console.log(JSON.stringify({...report,reportPath,journalPath}));
  globalThis.fetch=nativeFetch;
  if(report.status!=="PASS_SANDBOX_ADAPTER") process.exitCode=1;
});

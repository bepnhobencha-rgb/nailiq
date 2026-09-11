import { describe, expect, it, vi } from "vitest";
import { createCardSandboxGuard, readCardSandboxConfig } from "../../../../scripts/qa-square-card-sandbox-guard";

const env = { NAILIQ_CARD_SANDBOX_QA:"1", NAILIQ_QA_SQUARE_ENVIRONMENT:"sandbox", DISABLE_OUTBOUND_SMS:"1",
  DISABLE_OUTBOUND_EMAIL:"1",DISABLE_OUTBOUND_CALLS:"1",NEXT_PUBLIC_SUPABASE_URL:"http://127.0.0.1:55631",
  DB_URL:"postgresql://postgres:postgres@127.0.0.1:55632/postgres",SUPABASE_SERVICE_ROLE_KEY:"PRIVATE_LOCAL_QA_KEY_12345",
  NAILIQ_QA_SQUARE_SANDBOX_APPLICATION_ID:"sandbox-sq0idb-syntheticapp",NAILIQ_QA_SQUARE_SANDBOX_MERCHANT_ID:"syntheticmerchant",
  NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID:"syntheticlocation",NAILIQ_QA_SQUARE_SANDBOX_ACCESS_TOKEN:"PRIVATE_SANDBOX_TOKEN_12345",
  NAILIQ_QA_SQUARE_NOTIFICATIONS_OFF_VERIFIED:"1" };
const cfg = readCardSandboxConfig(env);
const authorizedCfg = readCardSandboxConfig({ ...env, NAILIQ_QA_SQUARE_NOTIFICATION_MODE:"test_notifications_authorized", NAILIQ_QA_SQUARE_NOTIFICATIONS_OFF_VERIFIED:undefined });
const json = (value: unknown) => new Response(JSON.stringify(value),{status:200});
function fixture(options?:{webhooks?:unknown;identity?:string},config=cfg) {
  const fetcher = vi.fn(async(input:RequestInfo|URL)=>{
    const url=String(input instanceof Request?input.url:input);
    if(url.endsWith("/oauth2/token/status"))return json({client_id:options?.identity??cfg.square.applicationId,merchant_id:cfg.square.merchantId});
    if(url.endsWith("/v2/locations"))return json({locations:[{id:cfg.square.locationId,merchant_id:cfg.square.merchantId,currency:"CAD",status:"ACTIVE"}]});
    if(url.includes("/webhooks/subscriptions"))return json(options?.webhooks??{});
    return json({card:{id:"syntheticcard"}});
  });
  return {fetcher,guard:createCardSandboxGuard(config,fetcher)};
}
describe("Square card-only Sandbox network guard",()=>{
  it("defaults to notifications OFF and refuses absent suppression evidence",()=>{
    expect(cfg.notificationMode).toBe("off_required");
    expect(()=>readCardSandboxConfig({...env,NAILIQ_QA_SQUARE_NOTIFICATIONS_OFF_VERIFIED:undefined})).toThrow("sandbox_notifications_off_unproven");
  });
  it.each(["", "authorized", "true", "OFF"])("rejects an unrecognized notification mode: %j",mode=>{
    expect(()=>readCardSandboxConfig({...env,NAILIQ_QA_SQUARE_NOTIFICATION_MODE:mode})).toThrow("sandbox_notification_mode_invalid");
  });
  it("records explicit test-notification authorization without representing it as suppression",()=>{
    expect(authorizedCfg.notificationMode).toBe("test_notifications_authorized");
    expect(authorizedCfg.square.environment).toBe("sandbox");
    expect(authorizedCfg.supabaseUrl).toBe("http://127.0.0.1:55631");
  });
  it.each([
    {NAILIQ_CARD_SANDBOX_QA:"0"},{NAILIQ_QA_SQUARE_ENVIRONMENT:"production"},{DISABLE_OUTBOUND_SMS:"0"},
    {DISABLE_OUTBOUND_EMAIL:"0"},{DISABLE_OUTBOUND_CALLS:"0"},{NEXT_PUBLIC_SUPABASE_URL:"https://real.supabase.co"},
    {DB_URL:"postgresql://postgres:secret@host.example:5432/postgres"},{NAILIQ_QA_SQUARE_SANDBOX_APPLICATION_ID:"sq0idp-real"},
    {DB_URL:"postgresql://postgres:postgres@127.0.0.1:55632/postgres?host=real.example"},
    {NAILIQ_QA_SQUARE_SANDBOX_WEBHOOK_ACCESS_TOKEN:""},
  ])("rejects unsafe configuration without I/O: %j",patch=>{
    expect(()=>readCardSandboxConfig({...env,...patch})).toThrow();
    expect(()=>readCardSandboxConfig({...env,NAILIQ_QA_SQUARE_NOTIFICATION_MODE:"test_notifications_authorized",...patch})).toThrow();
  });
  it("requires a successful preflight before mutation",async()=>{
    const {guard,fetcher}=fixture();await expect(guard.fetch("https://connect.squareupsandbox.com/v2/cards",{method:"POST"})).rejects.toThrow("sandbox_preflight_required");expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{subscriptions:[{enabled:true}]},{subscriptions:[{}]},{subscriptions:{}},{cursor:42}])("blocks unproven webhooks OFF: %j",async webhooks=>{
    const {guard}=fixture({webhooks});await expect(guard.preflight()).rejects.toThrow();
  });
  it("keeps webhook suppression required when test email/SMS notifications are authorized",async()=>{
    const {guard,fetcher}=fixture({webhooks:{subscriptions:[{enabled:true}]}},authorizedCfg);
    await expect(guard.preflight()).rejects.toThrow("sandbox_webhooks_not_disabled");
    const calls=fetcher.mock.calls.length;
    await expect(guard.fetch("https://connect.squareupsandbox.com/v2/cards",{method:"POST"})).rejects.toThrow("sandbox_preflight_required");
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it("keeps Sandbox identity verification required when test notifications are authorized",async()=>{
    const {guard}=fixture({identity:"other_application"},authorizedCfg);
    await expect(guard.preflight()).rejects.toThrow("sandbox_identity_mismatch");
  });
  it("blocks mismatched app/token identities",async()=>{
    const {guard}=fixture({identity:"other_application"});await expect(guard.preflight()).rejects.toThrow("sandbox_identity_mismatch");
  });
  function splitTokenFixture(options?: { webhookApp?: string; webhookFailure?: "http" | "timeout"; laterEnabled?: boolean }) {
    const config = readCardSandboxConfig({ ...env, NAILIQ_QA_SQUARE_SANDBOX_WEBHOOK_ACCESS_TOKEN:"PRIVATE_APP_SANDBOX_TOKEN_67890" });
    const calls: { path:string; authorization:string; method:string }[] = [];
    const fetcher = vi.fn(async (input:RequestInfo|URL, init?:RequestInit) => {
      const request = new Request(input,init);
      const url = new URL(request.url);
      const authorization = request.headers.get("Authorization") ?? "";
      calls.push({path:url.pathname+url.search,authorization,method:request.method});
      if (url.origin !== "https://connect.squareupsandbox.com") throw new Error("unexpected_environment");
      if (url.pathname === "/oauth2/token/status") {
        return json(authorization === `Bearer ${config.webhookAccessToken}`
          ? {client_id:options?.webhookApp ?? config.square.applicationId,merchant_id:"default_test_account"}
          : {client_id:config.square.applicationId,merchant_id:config.square.merchantId});
      }
      if (url.pathname === "/v2/locations") {
        if (authorization !== `Bearer ${config.square.accessToken}`) return new Response(null,{status:403});
        return json({locations:[{id:config.square.locationId,merchant_id:config.square.merchantId,currency:"CAD",status:"ACTIVE"}]});
      }
      if (url.pathname === "/v2/webhooks/subscriptions") {
        if (authorization !== `Bearer ${config.webhookAccessToken}` || options?.webhookFailure === "http") return new Response(null,{status:401});
        if (options?.webhookFailure === "timeout") throw new Error("PRIVATE_PROVIDER_RESPONSE");
        return json(url.search ? {subscriptions:[{enabled:options?.laterEnabled ?? false}]} : {cursor:"second-page"});
      }
      return json({card:{id:"syntheticcard"}});
    });
    return {config,calls,fetcher,guard:createCardSandboxGuard(config,fetcher)};
  }
  it("uses seller OAuth for CAD calls and the same app's personal token for every webhook page",async()=>{
    const {guard,config,calls}=splitTokenFixture();await guard.preflight();
    expect(calls).toHaveLength(5);
    expect(calls.filter(call=>call.path.startsWith("/v2/webhooks/")).map(call=>call.authorization)).toEqual([
      `Bearer ${config.webhookAccessToken}`,`Bearer ${config.webhookAccessToken}`,
    ]);
    expect(calls.find(call=>call.path==="/v2/locations")?.authorization).toBe(`Bearer ${config.square.accessToken}`);
    await guard.fetch("https://connect.squareupsandbox.com/v2/cards?reference_id=nq-card:11111111-1111-4111-8111-111111111111",{headers:{Authorization:`Bearer ${config.square.accessToken}`}});
    expect(calls.at(-1)?.authorization).toBe(`Bearer ${config.square.accessToken}`);
  });
  it("rejects a personal token from another app before reading subscriptions or allowing mutation",async()=>{
    const {guard,calls}=splitTokenFixture({webhookApp:"sandbox-sq0idb-otherapp"});
    await expect(guard.preflight()).rejects.toThrow("sandbox_webhook_identity_mismatch");
    expect(calls.some(call=>call.path.startsWith("/v2/webhooks/"))).toBe(false);
    await expect(guard.fetch("https://connect.squareupsandbox.com/v2/cards",{method:"POST"})).rejects.toThrow("sandbox_preflight_required");
    expect(calls).toHaveLength(3);
  });
  it.each(["http","timeout"] as const)("keeps mutations disarmed when personal-token webhook read fails: %s",async webhookFailure=>{
    const {guard,calls}=splitTokenFixture({webhookFailure});
    const failure=await guard.preflight().catch((error:Error)=>error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("sandbox_preflight_failed");
    const count=calls.length;
    await expect(guard.fetch("https://connect.squareupsandbox.com/v2/cards",{method:"POST"})).rejects.toThrow("sandbox_preflight_required");
    expect(calls).toHaveLength(count);
  });
  it("does not let the app token authorize seller calls or webhook mutation after preflight",async()=>{
    const {guard,config,calls}=splitTokenFixture();await guard.preflight();const count=calls.length;
    await expect(guard.fetch("https://connect.squareupsandbox.com/v2/cards",{method:"POST",headers:{Authorization:`Bearer ${config.webhookAccessToken}`}})).rejects.toThrow("sandbox_token_mismatch");
    await expect(guard.fetch("https://connect.squareupsandbox.com/v2/webhooks/subscriptions",{method:"POST",headers:{Authorization:`Bearer ${config.webhookAccessToken}`}})).rejects.toThrow("card_only_route_denied");
    expect(calls).toHaveLength(count);
  });
  it("blocks enabled subscriptions on a later page with separate webhook credentials",async()=>{
    const {guard}=splitTokenFixture({laterEnabled:true});
    await expect(guard.preflight()).rejects.toThrow("sandbox_webhooks_not_disabled");
  });
  it.each([cfg,authorizedCfg])("blocks production, charge, refund and outbound-message requests in $notificationMode",async config=>{
    const {guard,fetcher}=fixture(undefined,config);await guard.preflight();const calls=fetcher.mock.calls.length;
    for(const url of ["https://connect.squareup.com/v2/cards","https://connect.squareupsandbox.com/v2/payments","https://connect.squareupsandbox.com/v2/refunds","https://api.twilio.com/messages","https://api.resend.com/emails"]){
      await expect(guard.fetch(url,{method:"POST"})).rejects.toThrow();
    }
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it.each([cfg,authorizedCfg])("rejects a real/unknown card source without printing it in $notificationMode",async config=>{
    const {guard,fetcher}=fixture(undefined,config);await guard.preflight();const calls=fetcher.mock.calls.length;
    const result=await guard.fetch("https://connect.squareupsandbox.com/v2/cards",{method:"POST",headers:{Authorization:`Bearer ${cfg.square.accessToken}`},body:JSON.stringify({source_id:"PRIVATE_SOURCE",card:{reference_id:"nq-card:11111111-1111-4111-8111-111111111111"}})}).catch(e=>e);
    expect(result.message).toBe("sandbox_fixed_source_required");expect(JSON.stringify(result)).not.toContain("PRIVATE_SOURCE");expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it.each([cfg,authorizedCfg])("allows only synthetic customer reads in $notificationMode",async config=>{
    const {guard,fetcher}=fixture(undefined,config);await guard.preflight();const calls=fetcher.mock.calls.length;
    await expect(guard.fetch("https://connect.squareupsandbox.com/v2/customers/search",{method:"POST",headers:{Authorization:`Bearer ${cfg.square.accessToken}`},body:JSON.stringify({query:{filter:{email_address:{exact:"PRIVATE_EMAIL"}}}})})).rejects.toThrow("synthetic_search_required");
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it("allows the same reserved-domain synthetic address for customer search and creation",async()=>{
    const {guard,fetcher}=fixture(undefined,authorizedCfg);await guard.preflight();
    const calls=fetcher.mock.calls.length;
    const email="synthetic-11111111-1111-4111-8111-111111111111@example.com";
    const headers={Authorization:`Bearer ${cfg.square.accessToken}`};
    await expect(guard.fetch("https://connect.squareupsandbox.com/v2/customers/search",{method:"POST",headers,body:JSON.stringify({query:{filter:{email_address:{exact:email}}}})})).resolves.toBeInstanceOf(Response);
    await expect(guard.fetch("https://connect.squareupsandbox.com/v2/customers",{method:"POST",headers,body:JSON.stringify({given_name:"Synthetic Sandbox",email_address:email,reference_id:"nq-customer:11111111-1111-4111-8111-111111111111"})})).resolves.toBeInstanceOf(Response);
    expect(fetcher).toHaveBeenCalledTimes(calls+2);
    expect(guard.counts().customerCreates).toBe(1);
  });
  it.each(["other@example.com","synthetic-@example.com","synthetic-case@example.test","synthetic-case@example.com.attacker.test","synthetic-case@sub.example.com"])("rejects a non-allowlisted email on both customer paths: %s",async email=>{
    const {guard,fetcher}=fixture(undefined,authorizedCfg);await guard.preflight();
    const calls=fetcher.mock.calls.length;
    const headers={Authorization:`Bearer ${cfg.square.accessToken}`};
    await expect(guard.fetch("https://connect.squareupsandbox.com/v2/customers/search",{method:"POST",headers,body:JSON.stringify({query:{filter:{email_address:{exact:email}}}})})).rejects.toThrow("synthetic_search_required");
    await expect(guard.fetch("https://connect.squareupsandbox.com/v2/customers",{method:"POST",headers,body:JSON.stringify({given_name:"Synthetic Sandbox",email_address:email,reference_id:"nq-customer:11111111-1111-4111-8111-111111111111"})})).rejects.toThrow("synthetic_customer_required");
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(guard.counts().customerCreates).toBe(0);
  });
  it("allows authorized card testing but preserves the 24-write ceiling across scenario resets",async()=>{
    const {guard,fetcher}=fixture(undefined,authorizedCfg);await guard.preflight();
    const calls=fetcher.mock.calls.length;
    const request={method:"POST",headers:{Authorization:`Bearer ${cfg.square.accessToken}`},body:JSON.stringify({source_id:"cnon:card-nonce-ok",card:{customer_id:"syntheticcustomer",reference_id:"nq-card:11111111-1111-4111-8111-111111111111"}})};
    for(let index=0;index<24;index+=1) {
      guard.setMode("success");
      await expect(guard.fetch("https://connect.squareupsandbox.com/v2/cards",request)).resolves.toBeInstanceOf(Response);
    }
    guard.setMode("success");
    await expect(guard.fetch("https://connect.squareupsandbox.com/v2/cards",request)).rejects.toThrow("sandbox_write_budget_exceeded");
    expect(fetcher).toHaveBeenCalledTimes(calls+24);
  });
  it("adds only the documented fixture postal code and loses one successful response",async()=>{
    const {guard,fetcher}=fixture();await guard.preflight();guard.setMode("response_loss");
    await expect(guard.fetch("https://connect.squareupsandbox.com/v2/cards",{method:"POST",headers:{Authorization:`Bearer ${cfg.square.accessToken}`},body:JSON.stringify({source_id:"cnon:card-nonce-ok",card:{customer_id:"syntheticcustomer",reference_id:"nq-card:11111111-1111-4111-8111-111111111111"}})})).rejects.toThrow("qa_provider_response_loss");
    const sent=fetcher.mock.calls.at(-1)?.[0] as Request;
    expect((await sent.clone().json()).card.billing_address).toEqual({postal_code:"94103"});
    expect(guard.counts()).toMatchObject({cardCreates:1,responseLossInjected:true});
  });
});

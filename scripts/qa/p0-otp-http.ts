import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

async function main() {
  const origin = "http://localhost:3131";
  assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL, "http://127.0.0.1:54321");
  assert.equal(process.env.SUPABASE_INTERNAL_URL, "http://127.0.0.1:54321");
  assert.equal(process.env.NAILIQ_DISPOSABLE_DB, "1");
  assert.equal(process.env.DEMO_OTP, "false");
  for (const key of ["DISABLE_OUTBOUND_SMS", "DISABLE_OUTBOUND_EMAIL", "DISABLE_OUTBOUND_CALLS"]) assert.equal(process.env[key], "1");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const settings = await db.from("platform_settings").select("twilio_account_sid,twilio_auth_token,twilio_verify_service_sid");
  assert.equal(settings.error, null);
  assert.ok(settings.data.every((row) => Object.values(row).every((value) => !value)));
  const before = await db.from("rate_limits").select("bucket"); assert.equal(before.error, null);
  const oldBuckets = new Set(before.data.map((row) => row.bucket));
  const id = randomUUID(); const slug = `e2e-otp-http-${id}`;
  const phone = "16045550197"; const email = "http-otp@example.test";
  const results: Array<Record<string, unknown>> = [];
  function ledgerStatus() {
    assert.match(id, /^[a-f0-9-]{36}$/);
    // Ledger intentionally denies even direct service-role REST access. Read
    // only synthetic statuses through the owned disposable database console.
    return JSON.parse(execFileSync("docker", ["exec", "supabase_db_nailiq-p0-signup-20260911", "psql", "-U", "postgres", "-d", "postgres", "-Atc", `select coalesce(json_agg(status),'[]'::json) from public.booking_otp_delivery_attempts where salon_id='${id}'::uuid`], { env: { ...process.env, DOCKER_HOST: "unix:///Users/huytran/.colima/nailiq-p0-503/docker.sock" }, encoding: "utf8" })) as string[];
  }
  async function post(route: string, body: unknown, ip = "192.0.2.41") {
    const response = await fetch(`${origin}/api/booking-otp/${route}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, origin }, body: JSON.stringify(body), redirect: "error" });
    return { status: response.status, body: await response.json(), retry: response.headers.get("retry-after") };
  }
  try {
    const inserted = await db.from("salons").insert({ id, slug, name: "E2E OTP HTTP", phone, timezone: "America/Los_Angeles", phone_otp_enabled: true, email_links_enabled: true }); assert.equal(inserted.error, null);
    for (const route of ["send", "verify", "consume-session"]) {
      for (const body of [null, [], { phone: 123, code: {}, sessionId: [] }, { phone, shopSlug: slug, padding: "x".repeat(4096) }]) {
        const response = await post(route, body); assert.equal(response.status, 400); assert.equal(typeof response.body.error, "string");
      }
      results.push({ case: `${route}: null/array/wrong types/oversized stream`, status: "PASS", requests: 4 });
    }
    const sms = await post("send", { phone, shopSlug: slug });
    assert.equal(sms.status, 503); assert.equal(sms.body.error, "sms_suppressed");
    const mail = await post("send", { phone, email, channel: "email", shopSlug: slug });
    assert.equal(mail.status, 503); assert.equal(mail.body.error, "email_suppressed");
    const attempts = ledgerStatus();
    assert.equal(attempts.length, 2); assert.ok(attempts.every((status) => status === "suppressed"));
    results.push({ case: "SMS/email suppression and durable receipt", status: "PASS", attempts: 2 });
    const codeId = randomUUID();
    const code = await db.from("email_otp_codes").insert({ id: codeId, salon_id: id, phone, email, code_hash: createHmac("sha256", process.env.INTERNAL_API_SECRET!).update("123456").digest("hex"), expires_at: new Date(Date.now() + 600_000).toISOString() }); assert.equal(code.error, null);
    const race = await Promise.all(Array.from({ length: 10 }, () => post("verify", { phone, email, shopSlug: slug, code: "123456" }, "192.0.2.42")));
    assert.equal(race.filter((r) => r.status === 200 && r.body.ok).length, 1);
    assert.ok(race.filter((r) => r.status !== 200).every((r) => r.status === 410));
    const sessions = await db.from("phone_otp_sessions").select("id,salon_id,phone").eq("salon_id", id); assert.equal(sessions.error, null); assert.equal(sessions.data.length, 1); assert.equal(sessions.data[0].phone, phone);
    const limited = await post("verify", { phone, email, shopSlug: slug, code: "123456" }, "192.0.2.43"); assert.equal(limited.status, 429);
    for (let i = 0; i < 2; i++) assert.equal((await post("consume-session", { sessionId: sessions.data[0].id })).status, 200);
    const consumed = await db.from("phone_otp_sessions").select("consumed_at").eq("id", sessions.data[0].id).single(); assert.equal(consumed.error, null); assert.ok(consumed.data.consumed_at);
    results.push({ case: "10 real verify HTTP calls create exactly one session; identity quota request11; idempotent consumption", status: "PASS" });
    for (let i = 0; i < 20; i++) assert.equal((await post("send", {}, "192.0.2.44")).status, 400);
    const ipQuota = await post("send", {}, "192.0.2.44"); assert.equal(ipQuota.status, 429); assert.equal(ipQuota.retry, "900");
    results.push({ case: "send IP quota request21 blocked", status: "PASS" });
  } finally {
    const deleted = await db.from("salons").delete().eq("id", id); assert.equal(deleted.error, null);
    for (const table of ["salons", "email_otp_codes", "phone_otp_sessions"]) {
      const query = await db.from(table).select("id", { head: true, count: "exact" }).eq(table === "salons" ? "id" : "salon_id", id); assert.equal(query.error, null); assert.equal(query.count, 0);
    }
    assert.deepEqual(ledgerStatus(), []);
    // This runner is serialized on the owned disposable stack. Remove only
    // newly created buckets; never reset a hosted/shared limiter.
    const after = await db.from("rate_limits").select("bucket"); assert.equal(after.error, null);
    const added = after.data.map((row) => row.bucket).filter((bucket) => !oldBuckets.has(bucket));
    if (added.length) { const removed = await db.from("rate_limits").delete().in("bucket", added); assert.equal(removed.error, null); }
    results.push({ case: "exact synthetic fixture and newly created local buckets cleaned", status: "PASS" });
  }
  writeFileSync(`${process.env.NAILIQ_QA_ARTIFACT_DIR}/p0-03-otp-http.json`, JSON.stringify({ environment: "local Next production build / disposable Supabase / providers OFF", results }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(results));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? { name: error.name, frames: error.stack?.split("\n").filter((line) => line.trim().startsWith("at ")).slice(0, 4) } : "HTTP OTP QA failed"); process.exitCode = 1; });

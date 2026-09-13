import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

async function main() {
  const origin = "http://127.0.0.1:54321";
  assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL, origin);
  assert.equal(process.env.SUPABASE_INTERNAL_URL, origin);
  assert.equal(process.env.NAILIQ_DISPOSABLE_DB, "1");
  for (const key of ["DISABLE_OUTBOUND_SMS", "DISABLE_OUTBOUND_EMAIL", "DISABLE_OUTBOUND_CALLS"]) assert.equal(process.env[key], "1");
  const nativeFetch = globalThis.fetch;
  let externalAttempts = 0;
  let rejectConsumption = false;
  let readsRemaining = 0;
  let readsCompleted = 0;
  let releaseReads: (() => void) | undefined;
  let readBarrier = Promise.resolve();
  function synchronizeFirstReads() {
    readsRemaining = 12;
    readsCompleted = 0;
    readBarrier = new Promise<void>((resolve) => { releaseReads = resolve; });
  }
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== origin) { externalAttempts++; throw new Error("Non-disposable request blocked"); }
    if (rejectConsumption && init?.method === "PATCH" && url.pathname === "/rest/v1/email_otp_codes") {
      return Promise.resolve(new Response(JSON.stringify({ code: "08006", message: "Synthetic write failure" }), { status: 503, headers: { "content-type": "application/json" } }));
    }
    const response = nativeFetch(input, { ...init, redirect: "error" });
    if (readsRemaining > 0 && (init?.method ?? "GET") === "GET" && url.pathname === "/rest/v1/email_otp_codes") {
      readsRemaining--;
      return response.then(async (result) => { await result.clone().text(); if (++readsCompleted === 12) releaseReads?.(); await readBarrier; return result; });
    }
    return response;
  };
  const { checkEmailOtp } = await import("../../src/shared/lib/emailOtp");
  const db = createClient(origin, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const salonId = randomUUID();
  const secondSalonId = randomUUID();
  const args = { salonId, phone: "16045550199", email: "otp-qa@example.test", code: "123456" };
  const results: Record<string, unknown> = { concurrencyMethod: "12 real database reads coordinated in the local HTTP test transport before allowing writes" };
  async function seed(overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    const { error } = await db.from("email_otp_codes").insert({ id, salon_id: salonId, phone: args.phone, email: args.email, code_hash: createHmac("sha256", process.env.INTERNAL_API_SECRET!).update(args.code).digest("hex"), expires_at: new Date(Date.now() + 600_000).toISOString(), ...overrides });
    assert.equal(error?.code ?? null, null);
    return id;
  }
  async function clearCodes() {
    const { error } = await db.from("email_otp_codes").delete().eq("salon_id", salonId);
    assert.equal(error?.code ?? null, null);
  }
  try {
    for (const id of [salonId, secondSalonId]) {
      const { error } = await db.from("salons").insert({ id, slug: `e2e-p003-otp-${id}`, name: "E2E OTP race QA", phone: "16045550199", timezone: "America/Los_Angeles", phone_otp_enabled: true });
      assert.equal(error?.code ?? null, null);
    }
    await seed();
    synchronizeFirstReads();
    const race = await Promise.all(Array.from({ length: 12 }, () => checkEmailOtp(args)));
    results.concurrentCorrectAccepted = race.filter((r) => r.ok).length;
    results.replayRejected = !(await checkEmailOtp(args)).ok;
    await clearCodes();
    const wrongId = await seed();
    synchronizeFirstReads();
    const wrong = await Promise.all(Array.from({ length: 12 }, () => checkEmailOtp({ ...args, code: "654321" })));
    results.concurrentWrongRejected = wrong.every((r) => !r.ok);
    const count = await db.from("email_otp_codes").select("attempts").eq("id", wrongId).single();
    assert.equal(count.error, null);
    results.persistedWrongAttempts = count.data.attempts;
    results.correctAfterExhaustionRejected = !(await checkEmailOtp(args)).ok;
    await clearCodes();
    await seed();
    rejectConsumption = true;
    results.writeFailureRejected = !(await checkEmailOtp(args)).ok;
    rejectConsumption = false;
    results.wrongSalonRejected = !(await checkEmailOtp({ ...args, salonId: secondSalonId })).ok;
    results.wrongEmailRejected = !(await checkEmailOtp({ ...args, email: "different@example.test" })).ok;
    results.wrongPhoneRejected = !(await checkEmailOtp({ ...args, phone: "16045550198" })).ok;
    results.validAfterBindingChecks = (await checkEmailOtp(args)).ok;
    await clearCodes();
    await seed({ expires_at: new Date(Date.now() - 60_000).toISOString() });
    results.expiredRejected = !(await checkEmailOtp(args)).ok;
  } finally {
    rejectConsumption = false;
    for (const id of [salonId, secondSalonId]) {
      const { error } = await db.from("salons").delete().eq("id", id);
      assert.equal(error?.code ?? null, null);
    }
    for (const table of ["salons", "email_otp_codes", "phone_otp_sessions"]) {
      const { count, error } = await db.from(table).select("id", { count: "exact", head: true }).in(table === "salons" ? "id" : "salon_id", [salonId, secondSalonId]);
      assert.equal(error, null); assert.equal(count, 0);
    }
    results.cleanup = "exact two synthetic salons and dependent codes/sessions: zero";
    results.externalAttempts = externalAttempts;
    globalThis.fetch = nativeFetch;
  }
  const observe = process.argv.includes("--observe-before");
  writeFileSync(`${process.env.NAILIQ_QA_ARTIFACT_DIR}/p0-03-otp-db-${observe ? "before" : "after"}.json`, JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(results));
  if (!observe) {
    assert.equal(results.concurrentCorrectAccepted, 1);
    assert.equal(results.persistedWrongAttempts, 5);
    for (const key of ["replayRejected", "concurrentWrongRejected", "correctAfterExhaustionRejected", "writeFailureRejected", "wrongSalonRejected", "wrongEmailRejected", "wrongPhoneRejected", "validAfterBindingChecks", "expiredRejected"]) assert.equal(results[key], true, key);
  }
  assert.equal(externalAttempts, 0);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? { name: error.name, code: (error as { code?: string }).code, frames: error.stack?.split("\n").filter((line) => line.trim().startsWith("at ")).slice(0, 4) } : "OTP disposable verification failed"); process.exitCode = 1; });

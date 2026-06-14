/**
 * Unit tests for normaliseToE164 — the recipient-phone normaliser used by
 * sendSmsReminder before calling Twilio.
 *
 * Twilio's `To` field requires strict E.164 ("+<digits>"). Callers historically
 * passed digits-only ("16045551234") or the raw string the voice AI captured —
 * neither is E.164. This guards that every accepted form is normalised, and that
 * un-normalisable input (bare local numbers, junk) is rejected so the send is
 * reported as failed rather than silently mis-routed.
 *
 * Importing twilioSms is safe in a unit context: the Supabase client is only
 * imported lazily inside getTwilioSmsCreds (await import), never at module load.
 *
 * Run: npx tsx src/shared/lib/__tests__/twilioSms.test.ts
 */
import { normaliseToE164, isFictionalTestNumber, smsSuppressReason } from "../twilioSms";

let pass = 0,
  fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}`);
    console.error(e);
  }
}
function assertEqual(actual: unknown, expected: unknown, msg?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${msg ?? ""}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

// ── Valid forms all normalise to strict E.164 (+digits) ─────────────
test("already-E.164 passes through unchanged", () => {
  assertEqual(normaliseToE164("+16045551234"), "+16045551234");
  assertEqual(normaliseToE164("+84901234567"), "+84901234567");
});
test("digits-only NANP (web path) gets the leading +", () => {
  // submitPublicBooking stores/forwards "16045551234" (no +) — must gain "+".
  assertEqual(normaliseToE164("16045551234"), "+16045551234");
});
test("bare 10-digit local resolves to +1 (default CA region)", () => {
  assertEqual(normaliseToE164("6045551234"), "+16045551234");
});
test("formatted input is cleaned then normalised", () => {
  assertEqual(normaliseToE164("604-555-0142"), "+16045550142");
  assertEqual(normaliseToE164("+1 (604) 555-0142"), "+16045550142");
});

// ── Invalid / un-normalisable input → null (treated as send failure) ─
test("bare Vietnamese local (no +84) is rejected, not mis-routed", () => {
  // "0905123456" with default CA region is not a valid number — must be null
  // so the caller reports smsSent=false instead of sending to a wrong number.
  assertEqual(normaliseToE164("0905123456"), null);
});
test("empty string → null", () => {
  assertEqual(normaliseToE164(""), null);
  assertEqual(normaliseToE164("   "), null);
});
test("junk → null", () => {
  assertEqual(normaliseToE164("not-a-phone"), null);
  assertEqual(normaliseToE164("12"), null);
});

// ── KILL-SWITCH: fictional 555-exchange detection ───────────────────
test("555 exchange numbers are flagged fictional (all seed forms)", () => {
  // NANP layout +1 AAA 555 XXXX — exchange "555" is reserved, never a real sub.
  assertEqual(isFictionalTestNumber("+16045550222"), true); // the leaked number
  assertEqual(isFictionalTestNumber("+16045550142"), true);
  assertEqual(isFictionalTestNumber("+16045551234"), true);
  assertEqual(isFictionalTestNumber("+16045552200"), true);
  assertEqual(isFictionalTestNumber("+12125559999"), true);
});
test("real customer numbers are NOT flagged fictional", () => {
  assertEqual(isFictionalTestNumber("+16045101234"), false); // exchange 510
  assertEqual(isFictionalTestNumber("+17789073426"), false); // the Twilio sender
  assertEqual(isFictionalTestNumber("+14155552671"), true);  // 555 exchange (still test)
  assertEqual(isFictionalTestNumber("+84901234567"), false); // non-NANP real
});

// ── KILL-SWITCH: smsSuppressReason precedence ───────────────────────
test("env flag suppresses regardless of recipient", () => {
  const prev = process.env.DISABLE_OUTBOUND_SMS;
  process.env.DISABLE_OUTBOUND_SMS = "1";
  assertEqual(smsSuppressReason("+16045101234"), "disabled_by_env");
  process.env.DISABLE_OUTBOUND_SMS = prev ?? "";
  if (prev === undefined) delete process.env.DISABLE_OUTBOUND_SMS;
});
test("DEMO_OTP/NEXT_PUBLIC_DEMO_OTP demo mode suppresses real numbers even in prod", () => {
  const prevFlag = process.env.DISABLE_OUTBOUND_SMS;
  const prevNode = process.env.NODE_ENV;
  const prevDemo = process.env.DEMO_OTP;
  const prevPubDemo = process.env.NEXT_PUBLIC_DEMO_OTP;
  delete process.env.DISABLE_OUTBOUND_SMS;
  (process.env as Record<string, string>).NODE_ENV = "production";
  // CI sets DEMO_OTP=true while running `next start` (NODE_ENV=production) —
  // this is the exact CI leak scenario; must suppress.
  process.env.DEMO_OTP = "true";
  delete process.env.NEXT_PUBLIC_DEMO_OTP;
  assertEqual(smsSuppressReason("+16045101234"), "demo_mode");
  // public flag alone also suppresses
  delete process.env.DEMO_OTP;
  process.env.NEXT_PUBLIC_DEMO_OTP = "true";
  assertEqual(smsSuppressReason("+16045101234"), "demo_mode");
  // restore
  (process.env as Record<string, string>).NODE_ENV = prevNode ?? "";
  if (prevFlag !== undefined) process.env.DISABLE_OUTBOUND_SMS = prevFlag;
  if (prevDemo !== undefined) process.env.DEMO_OTP = prevDemo; else delete process.env.DEMO_OTP;
  if (prevPubDemo !== undefined) process.env.NEXT_PUBLIC_DEMO_OTP = prevPubDemo; else delete process.env.NEXT_PUBLIC_DEMO_OTP;
});
test("non-production env suppresses real numbers", () => {
  const prevFlag = process.env.DISABLE_OUTBOUND_SMS;
  const prevNode = process.env.NODE_ENV;
  delete process.env.DISABLE_OUTBOUND_SMS;
  // tsx runs with NODE_ENV unset/"test" → must suppress.
  (process.env as Record<string, string>).NODE_ENV = "test";
  assertEqual(smsSuppressReason("+16045101234"), "non_production_env");
  (process.env as Record<string, string>).NODE_ENV = prevNode ?? "";
  if (prevFlag !== undefined) process.env.DISABLE_OUTBOUND_SMS = prevFlag;
});
test("in production: real number sends, 555/test-salon suppressed", () => {
  const prevFlag = process.env.DISABLE_OUTBOUND_SMS;
  const prevNode = process.env.NODE_ENV;
  delete process.env.DISABLE_OUTBOUND_SMS;
  (process.env as Record<string, string>).NODE_ENV = "production";
  assertEqual(smsSuppressReason("+16045101234"), null);                 // real → send
  assertEqual(smsSuppressReason("+16045550222"), "fictional_test_number"); // seed → block
  assertEqual(smsSuppressReason("+16045101234", { salonIsTest: true }), "test_salon");
  (process.env as Record<string, string>).NODE_ENV = prevNode ?? "";
  if (prevFlag !== undefined) process.env.DISABLE_OUTBOUND_SMS = prevFlag;
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

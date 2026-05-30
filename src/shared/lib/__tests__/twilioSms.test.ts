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
import { normaliseToE164 } from "../twilioSms";

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

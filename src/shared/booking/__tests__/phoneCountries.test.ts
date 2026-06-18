// Direct smoke test — run with: npx tsx src/shared/booking/__tests__/phoneCountries.test.ts
// Verifies the supported-country list ordering, timezone-based defaulting, and
// the E.164 builder used by the booking phone picker.

import {
  PHONE_COUNTRIES,
  defaultPhoneCountry,
  countryByIso,
  toE164Input,
} from "../phoneCountries";

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

console.log("[ordering — North America cluster first]");
check("US is first", PHONE_COUNTRIES[0].iso === "US");
check("Canada is second", PHONE_COUNTRIES[1].iso === "CA");
check("Mexico is third (+52)", PHONE_COUNTRIES[2].iso === "MX" && PHONE_COUNTRIES[2].dial === "52");
check("Vietnam is last", PHONE_COUNTRIES[PHONE_COUNTRIES.length - 1].iso === "VN");
check("UK present (+44)", !!countryByIso("GB") && countryByIso("GB")!.dial === "44");
check("France present (+33)", countryByIso("FR")?.dial === "33");

console.log("[default country from salon timezone]");
check("America/Vancouver → Canada", defaultPhoneCountry("America/Vancouver").iso === "CA");
check("America/Los_Angeles → US", defaultPhoneCountry("America/Los_Angeles").iso === "US");
check("America/Mexico_City → Mexico", defaultPhoneCountry("America/Mexico_City").iso === "MX");
check("Europe/Paris → France", defaultPhoneCountry("Europe/Paris").iso === "FR");
check("Europe/London → UK", defaultPhoneCountry("Europe/London").iso === "GB");
check("Asia/Ho_Chi_Minh → Vietnam", defaultPhoneCountry("Asia/Ho_Chi_Minh").iso === "VN");
check("unknown tz → US fallback", defaultPhoneCountry("Mars/Phobos").iso === "US");
check("null tz → US fallback", defaultPhoneCountry(null).iso === "US");

console.log("[toE164Input — national → +<dial><national>]");
check("FR strips trunk 0", toE164Input(countryByIso("FR")!, "06 12 34 56 78") === "+33612345678");
check("GB", toE164Input(countryByIso("GB")!, "7700 900123") === "+447700900123");
check("US formats stripped", toE164Input(countryByIso("US")!, "(213) 555-0123") === "+12135550123");
check("MX", toE164Input(countryByIso("MX")!, "55 1234 5678") === "+525512345678");
check("empty → ''", toE164Input(countryByIso("US")!, "") === "");

console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAIL`}`);
process.exit(failures === 0 ? 0 : 1);

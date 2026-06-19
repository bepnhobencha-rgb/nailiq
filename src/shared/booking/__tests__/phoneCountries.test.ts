// Direct smoke test — run with: npx tsx src/shared/booking/__tests__/phoneCountries.test.ts
// Verifies the worldwide country list (every country selectable), priority
// ordering, timezone-based defaulting, and the E.164 builder.

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

console.log("[full worldwide list]");
check("has 200+ countries", PHONE_COUNTRIES.length >= 200);
check("Singapore selectable (+65)", countryByIso("SG")?.dial === "65");
check("Australia selectable (+61)", countryByIso("AU")?.dial === "61");
check("UAE selectable (+971)", countryByIso("AE")?.dial === "971");
check("every entry has iso/dial/name", PHONE_COUNTRIES.every((c) => !!c.iso && !!c.dial && !!c.name));

console.log("[priority ordering on top]");
check("US first", PHONE_COUNTRIES[0].iso === "US");
check("Canada second", PHONE_COUNTRIES[1].iso === "CA");
check("Mexico third", PHONE_COUNTRIES[2].iso === "MX");

console.log("[default country from salon timezone]");
check("Asia/Singapore → Singapore", defaultPhoneCountry("Asia/Singapore").iso === "SG");
check("America/Vancouver → Canada", defaultPhoneCountry("America/Vancouver").iso === "CA");
check("America/Los_Angeles → US", defaultPhoneCountry("America/Los_Angeles").iso === "US");
check("America/Mexico_City → Mexico", defaultPhoneCountry("America/Mexico_City").iso === "MX");
check("Europe/Paris → France", defaultPhoneCountry("Europe/Paris").iso === "FR");
check("Europe/London → UK", defaultPhoneCountry("Europe/London").iso === "GB");
check("Asia/Dubai → UAE", defaultPhoneCountry("Asia/Dubai").iso === "AE");
check("Australia/Sydney → Australia", defaultPhoneCountry("Australia/Sydney").iso === "AU");
check("Asia/Ho_Chi_Minh → Vietnam", defaultPhoneCountry("Asia/Ho_Chi_Minh").iso === "VN");
check("unknown tz → US fallback", defaultPhoneCountry("Mars/Phobos").iso === "US");
check("null tz → US fallback", defaultPhoneCountry(null).iso === "US");

console.log("[toE164Input — national → +<dial><national>]");
check("Singapore", toE164Input(countryByIso("SG")!, "8123 4567") === "+6581234567");
check("FR strips trunk 0", toE164Input(countryByIso("FR")!, "06 12 34 56 78") === "+33612345678");
check("US formats stripped", toE164Input(countryByIso("US")!, "(213) 555-0123") === "+12135550123");
check("empty → ''", toE164Input(countryByIso("US")!, "") === "");

console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAIL`}`);
process.exit(failures === 0 ? 0 : 1);

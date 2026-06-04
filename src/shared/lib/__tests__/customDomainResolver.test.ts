/**
 * Safety tests for custom-domain host classification.
 *
 * Run: npx tsx src/shared/lib/__tests__/customDomainResolver.test.ts
 *
 * The critical invariant: platform hosts (nailiq.ca, *.vercel.app, localhost)
 * MUST be classified as platform so the proxy never rewrites normal traffic to
 * a tenant page. Custom hosts must NOT be misclassified as platform.
 */

let pass = 0,
  fail = 0;

function check(name: string, actual: boolean, expected: boolean) {
  if (actual === expected) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name} — expected ${expected}, got ${actual}`);
  }
}

import { isPlatformHost } from "../customDomainResolver";

// Platform hosts → true (never treated as a custom tenant domain).
check("nailiq.ca is platform", isPlatformHost("nailiq.ca"), true);
check("www.nailiq.ca is platform", isPlatformHost("www.nailiq.ca"), true);
check("preview .vercel.app is platform", isPlatformHost("nailiq-abc123.vercel.app"), true);
check("localhost is platform", isPlatformHost("localhost"), true);
check("localhost:3000 is platform", isPlatformHost("localhost:3000"), true);
check("127.0.0.1 is platform", isPlatformHost("127.0.0.1"), true);
check("empty host treated as platform", isPlatformHost(""), true);

// Custom tenant domains → false (eligible for host rewrite).
check("hiliteheadspa.com is custom", isPlatformHost("hiliteheadspa.com"), false);
check("www.hiliteheadspa.com is custom", isPlatformHost("www.hiliteheadspa.com"), false);
check("book.hiliteheadspa.com is custom", isPlatformHost("book.hiliteheadspa.com"), false);
check("uppercase custom host", isPlatformHost("HiLiteHeadSpa.com"), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

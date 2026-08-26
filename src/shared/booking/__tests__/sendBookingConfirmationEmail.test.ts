/**
 * Unit tests for the booking confirmation email's self-serve manage-links
 * branch (PR #349 #2). `buildHtml` is a pure render function, so we assert the
 * HTML it returns directly:
 *   - manageLinks set     → Reschedule + Cancel links present, no "contact" copy
 *   - manageLinks null    → "contact the salon" fallback, no manage links
 *
 * Run:  npx tsx src/shared/booking/__tests__/sendBookingConfirmationEmail.test.ts
 */
import { buildHtml, type ManageLinks } from "../sendBookingConfirmationEmail";

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
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const INPUT = {
  bookingId: "b-1",
  shopSlug: "hilite-anaheim",
  clientName: "Mai",
  clientEmail: "mai@example.com",
  serviceName: "Signature Head Spa",
  staffName: "Anna",
  startTimeUtc: "2026-07-01T17:00:00.000Z",
  totalPriceCents: 9000,
};

const CONFIRM_URL = "https://nailiq.ca/booking/status?token=11111111-1111-4111-8111-111111111111";
const LINKS: ManageLinks = {
  reschedule: "https://nailiq.ca/booking/reschedule?token=tok-123",
  cancel: "https://nailiq.ca/booking/cancel?token=tok-123",
};

// ── manageLinks present → reschedule + cancel links, no "contact" fallback ──
test("renders reschedule + cancel links when manageLinks is set", () => {
  const html = buildHtml("Hi-Lite Head Spa", INPUT, "Wed, July 1", CONFIRM_URL, "USD", LINKS);
  assert(html.includes(LINKS.reschedule), "reschedule link present");
  assert(html.includes(LINKS.cancel), "cancel link present");
  assert(/>\s*Reschedule\s*</.test(html), "Reschedule label present");
  assert(/>\s*Cancel\s*</.test(html), "Cancel label present");
  assert(
    !html.includes("Contact <strong>"),
    "no contact-the-salon fallback when self-serve links are shown",
  );
});

// ── manageLinks null → contact-salon fallback, no manage links ──
test("falls back to 'contact the salon' when manageLinks is null", () => {
  const html = buildHtml("Hi-Lite Head Spa", INPUT, "Wed, July 1", CONFIRM_URL, "USD", null);
  assert(html.includes("Need to reschedule? Contact"), "fallback copy present");
  assert(!html.includes("/booking/reschedule"), "no reschedule link in fallback");
  assert(!html.includes("/booking/cancel"), "no cancel link in fallback");
});

// ── The primary CTA (View Booking Status) is always present, both branches ──
test("confirm CTA is present regardless of manage-links branch", () => {
  const withLinks = buildHtml("Hi-Lite", INPUT, "Wed", CONFIRM_URL, "USD", LINKS);
  const without = buildHtml("Hi-Lite", INPUT, "Wed", CONFIRM_URL, "USD", null);
  assert(withLinks.includes(CONFIRM_URL), "confirm URL present (with links)");
  assert(without.includes(CONFIRM_URL), "confirm URL present (fallback)");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

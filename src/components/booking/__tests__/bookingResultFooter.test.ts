/**
 * Unit tests for bookingResultFooterNote — the Voice AI booking-result footer.
 *
 * Focus: the UI must NEVER claim "Confirmation SMS sent" unless the backend
 * confirmed the send (smsSent === true). This is the regression guard for the
 * "UI says SMS sent but no SMS was received" bug.
 *
 * Run: npx tsx src/components/booking/__tests__/bookingResultFooter.test.ts
 */
import { bookingResultFooterNote } from "../bookingResultFooter";

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
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const SENT_EN = "📱 Confirmation SMS sent";
const SENT_VI = "📱 Tin nhắn xác nhận đã được gửi";
const NEUTRAL_EN = "✓ Booking confirmed. SMS confirmation could not be sent.";
const NEUTRAL_VI = "✓ Đã đặt lịch. Không gửi được tin nhắn xác nhận.";

// ── booked + SMS actually sent → may claim "sent" ───────────────────
test("booked + smsSent=true → claims SMS sent (en)", () => {
  assertEqual(bookingResultFooterNote({ action: "booked", smsSent: true }, "en"), SENT_EN);
});
test("booked + smsSent=true → claims SMS sent (vi)", () => {
  assertEqual(bookingResultFooterNote({ action: "booked", smsSent: true }, "vi"), SENT_VI);
});

// ── booked + SMS NOT sent → MUST NOT claim "sent" (the core bug) ─────
test("booked + smsSent=false → neutral, does NOT claim sent (en)", () => {
  const out = bookingResultFooterNote({ action: "booked", smsSent: false }, "en");
  assertEqual(out, NEUTRAL_EN);
  assert(out !== SENT_EN, "must not be the SMS-sent string");
});
test("booked + smsSent=false → neutral, does NOT claim sent (vi)", () => {
  const out = bookingResultFooterNote({ action: "booked", smsSent: false }, "vi");
  assertEqual(out, NEUTRAL_VI);
  assert(out !== SENT_VI, "must not be the SMS-sent string");
});
test("booked + smsSent undefined → treated as NOT sent (en)", () => {
  // A missing flag must default to the neutral message, never the sent claim.
  assertEqual(bookingResultFooterNote({ action: "booked" }, "en"), NEUTRAL_EN);
});

// ── rescheduled / cancelled never mention SMS ───────────────────────
test("rescheduled → schedule-updated note regardless of smsSent", () => {
  assertEqual(bookingResultFooterNote({ action: "rescheduled", smsSent: true }, "en"), "📅 Schedule updated");
  assertEqual(bookingResultFooterNote({ action: "rescheduled", smsSent: false }, "vi"), "📅 Lịch hẹn đã được cập nhật");
});
test("cancelled → removed-from-schedule note regardless of smsSent", () => {
  assertEqual(bookingResultFooterNote({ action: "cancelled", smsSent: true }, "en"), "✓ Appointment removed from schedule");
  assertEqual(bookingResultFooterNote({ action: "cancelled", smsSent: false }, "vi"), "✓ Lịch hẹn đã được huỷ");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

/**
 * Unit tests for staffActionMessages builders.
 *
 * Run: npx tsx src/shared/notifications/__tests__/staffActionMessages.test.ts
 */

import {
  buildStaffActionSms,
  buildStaffActionEmailSubject,
} from "../staffActionMessages";

let pass = 0,
  fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    // eslint-disable-next-line no-console
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const vars = {
  customerName: "Mai",
  salonName: "Hi-Lite Head Spa",
  serviceName: "Hi Lite Classic",
  whenLabel: "Sat, Jun 14 at 2:00 PM",
  salonPhone: "(714) 555-1234",
};

test("EN cancel mentions cancelled + service + time", () => {
  const m = buildStaffActionSms("cancel", "en", vars)!;
  assert(m.includes("cancelled"), "has cancelled");
  assert(m.includes("Hi Lite Classic"), "has service");
  assert(m.includes("2:00 PM"), "has time");
  assert(m.startsWith("Hi Mai,"), "greets by name");
});

test("VI reschedule uses 'dời'", () => {
  const m = buildStaffActionSms("reschedule", "vi", vars)!;
  assert(m.includes("dời"), "has dời");
  assert(m.startsWith("Chào Mai,"), "vi greeting");
});

test("EN create says booked", () => {
  assert(buildStaffActionSms("create", "en", vars)!.includes("is booked"), "booked");
});

test("no_show SMS is null (handled by win-back)", () => {
  assert(buildStaffActionSms("no_show", "en", vars) === null, "null en");
  assert(buildStaffActionSms("no_show", "vi", vars) === null, "null vi");
});

test("empty name → no leading greeting", () => {
  const m = buildStaffActionSms("cancel", "en", { ...vars, customerName: "" })!;
  assert(m.startsWith("your "), "starts with 'your'");
});

test("no phone → no call line", () => {
  const m = buildStaffActionSms("cancel", "en", { ...vars, salonPhone: null })!;
  assert(!m.includes("Call"), "no call line");
});

test("email subjects per event + locale", () => {
  assert(buildStaffActionEmailSubject("cancel", "en", "X")!.includes("cancelled"), "en cancel subj");
  assert(buildStaffActionEmailSubject("cancel", "vi", "X")!.includes("huỷ"), "vi cancel subj");
  assert(buildStaffActionEmailSubject("no_show", "en", "X") === null, "no_show null");
});

// eslint-disable-next-line no-console
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

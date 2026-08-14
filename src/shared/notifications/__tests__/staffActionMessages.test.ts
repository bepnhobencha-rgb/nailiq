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
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
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
  staffName: "Anna",
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

test("staff_change keeps time and names the replacement without saying rescheduled", () => {
  const en = buildStaffActionSms("staff_change", "en", vars)!;
  assert(en.includes("remains scheduled"), "keeps original schedule");
  assert(en.includes("Anna"), "names replacement");
  assert(!en.includes("moved"), "does not claim time moved");

  const vi = buildStaffActionSms("staff_change", "vi", vars)!;
  assert(vi.includes("vẫn giữ nguyên"), "vi says time stays unchanged");
  assert(vi.includes("Anna"), "vi names replacement");
});

test("requested staff change explains the unavailable request and replacement", () => {
  const requested = {
    ...vars,
    previousStaffName: "Bella",
    customerRequestedPreviousStaff: true,
  };
  const en = buildStaffActionSms("staff_change", "en", requested)!;
  assert(en.includes("Bella is no longer available"), "names unavailable requested provider");
  assert(en.includes("We arranged Anna"), "names replacement");
  assert(en.includes("time remains"), "keeps original time");

  const vi = buildStaffActionSms("staff_change", "vi", requested)!;
  assert(vi.includes("Bella không còn phục vụ"), "vi names unavailable provider");
  assert(vi.includes("đã sắp xếp Anna"), "vi names replacement");
  assert(vi.includes("thời gian vẫn giữ nguyên"), "vi keeps original time");
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
  assert(buildStaffActionEmailSubject("staff_change", "vi", "X")!.includes("nhân viên"), "staff change vi");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

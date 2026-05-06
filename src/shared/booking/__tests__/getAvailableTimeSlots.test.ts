import { computeTimeSlots } from "../getAvailableTimeSlots";
import { BOOKING_ANY_STAFF_ID } from "../bookingStaffConstants";

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

// Always-open week (09:00–19:00 every day) so we never lose to the "closed today"
// branch. Day keys must match DAY_KEYS in openingHoursDefaults.ts (3-letter).
const HOURS_9_TO_19 = {
  mon: { open: "09:00", close: "19:00", closed: false },
  tue: { open: "09:00", close: "19:00", closed: false },
  wed: { open: "09:00", close: "19:00", closed: false },
  thu: { open: "09:00", close: "19:00", closed: false },
  fri: { open: "09:00", close: "19:00", closed: false },
  sat: { open: "09:00", close: "19:00", closed: false },
  sun: { open: "09:00", close: "19:00", closed: false },
};

const STAFF = [{ id: "s1", name: "Jenny", job_role: "nail_tech" }] as const;

// A safely-future weekday that avoids "today" past-time filtering. May 5 2030 is a Sunday.
const FUTURE_DATE = new Date(2030, 4, 5);
const NOW_MS = new Date(2030, 4, 4, 12, 0, 0, 0).getTime();

test("close=19:00 service=55min → last slot is 6:00 PM (NOT 6:30 PM)", () => {
  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: BOOKING_ANY_STAFF_ID,
    staffList: STAFF,
    serviceDurationMinutes: 55,
    occupancy: [],
    nowMs: NOW_MS,
  });

  const labels = slots.map((s) => s.label);
  // Last slot 6:00 PM → end 6:55 PM ≤ close 7:00 PM
  if (!labels.includes("6:00 PM")) {
    throw new Error(`expected 6:00 PM in slots; got: ${labels.join(", ")}`);
  }
  // 6:30 PM → end 7:25 PM > close 7:00 PM, must be excluded
  if (labels.includes("6:30 PM")) {
    throw new Error(`6:30 PM should NOT be a slot; got: ${labels.join(", ")}`);
  }
});

test("close=19:00 service=30min → last slot is 6:30 PM", () => {
  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: BOOKING_ANY_STAFF_ID,
    staffList: STAFF,
    serviceDurationMinutes: 30,
    occupancy: [],
    nowMs: NOW_MS,
  });

  const labels = slots.map((s) => s.label);
  if (!labels.includes("6:30 PM")) {
    throw new Error(`expected 6:30 PM in slots; got: ${labels.join(", ")}`);
  }
});

test("booked slot is returned with available=false (not hidden)", () => {
  // Pre-occupy 4:30 PM for the only staff member.
  const occStart = new Date(2030, 4, 5, 16, 30, 0, 0);
  const occEnd = new Date(2030, 4, 5, 17, 25, 0, 0);

  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: "s1",
    staffList: STAFF,
    serviceDurationMinutes: 55,
    occupancy: [
      {
        staff_id: "s1",
        start_time_utc: occStart.toISOString(),
        end_time_utc: occEnd.toISOString(),
      },
    ],
    nowMs: NOW_MS,
  });

  const booked = slots.find((s) => s.label === "4:30 PM");
  if (!booked) {
    throw new Error(
      `expected 4:30 PM still in returned slots (disabled, not hidden); got labels: ${slots
        .map((s) => s.label)
        .join(", ")}`,
    );
  }
  assertEqual(booked.available, false, "4:30 PM should be marked unavailable");

  // Earlier slot (e.g. 9:00 AM) is untouched and remains available.
  const free = slots.find((s) => s.label === "9:00 AM");
  if (!free) throw new Error(`expected 9:00 AM in slots`);
  assertEqual(free.available, true, "9:00 AM should be available");
});

test("any-staff: slot is available if at least one staff is free", () => {
  const occStart = new Date(2030, 4, 5, 10, 0, 0, 0);
  const occEnd = new Date(2030, 4, 5, 10, 55, 0, 0);

  const twoStaff = [
    { id: "s1", name: "Jenny", job_role: "nail_tech" },
    { id: "s2", name: "Mai", job_role: "nail_tech" },
  ];

  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: BOOKING_ANY_STAFF_ID,
    staffList: twoStaff,
    serviceDurationMinutes: 55,
    occupancy: [
      {
        staff_id: "s1",
        start_time_utc: occStart.toISOString(),
        end_time_utc: occEnd.toISOString(),
      },
    ],
    nowMs: NOW_MS,
  });

  // Only s1 is busy at 10:00 AM, s2 is free → any-staff is still available
  const ten = slots.find((s) => s.label === "10:00 AM");
  if (!ten) throw new Error("expected 10:00 AM in slots");
  assertEqual(
    ten.available,
    true,
    "10:00 AM should be available (s2 free) under any-staff",
  );
});

test("closed day → empty array", () => {
  const closedHours = {
    ...HOURS_9_TO_19,
    sun: { open: "09:00", close: "19:00", closed: true },
  };
  const slots = computeTimeSlots({
    openingHoursRaw: closedHours,
    selectedDate: FUTURE_DATE, // Sunday
    staffId: BOOKING_ANY_STAFF_ID,
    staffList: STAFF,
    serviceDurationMinutes: 55,
    occupancy: [],
    nowMs: NOW_MS,
  });
  assertEqual(slots.length, 0);
});

test("today + past time → past slots filtered out (still hidden)", () => {
  // Today = 2030-05-05 at 14:00 wall time.
  const today = new Date(2030, 4, 5);
  const wallNoon = new Date(2030, 4, 5, 14, 0, 0, 0).getTime();

  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: today,
    staffId: BOOKING_ANY_STAFF_ID,
    staffList: STAFF,
    serviceDurationMinutes: 30,
    occupancy: [],
    nowMs: wallNoon,
  });

  // 9:00 AM is in the past → must be hidden
  const labels = slots.map((s) => s.label);
  if (labels.includes("9:00 AM")) {
    throw new Error(
      `9:00 AM should be hidden when 'now' is 2:00 PM same day; got: ${labels.join(", ")}`,
    );
  }
  // 2:30 PM (within 15-min buffer of 2:00 PM) also filtered
  if (labels.includes("2:00 PM") || labels.includes("2:15 PM")) {
    throw new Error(`slots within 15min lead buffer should be hidden`);
  }
  // 2:30 PM exactly is inside lead buffer (now=14:00, buffer=15m → 14:15 cutoff;
  // 14:30 ≥ 14:15 → kept); 2:30 PM should remain
  if (!labels.includes("2:30 PM")) {
    throw new Error(`expected 2:30 PM (after lead buffer) in slots`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

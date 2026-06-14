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

// ─── Phase 1: 15-min grid ────────────────────────────────────────────────────

test("close=19:00 service=55min → last slot is 6:00 PM (NOT 6:15 PM or later)", () => {
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
  // 6:00 PM + 55 min = 6:55 PM ≤ 7:00 PM → included
  if (!labels.includes("6:00 PM")) {
    throw new Error(`expected 6:00 PM in slots; got: ${labels.join(", ")}`);
  }
  // 6:15 PM + 55 min = 7:10 PM > 7:00 PM → excluded
  if (labels.includes("6:15 PM")) {
    throw new Error(`6:15 PM should NOT be a slot (service runs past close); got: ${labels.join(", ")}`);
  }
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
  // 6:30 PM + 30 min = 7:00 PM ≤ 7:00 PM → included
  if (!labels.includes("6:30 PM")) {
    throw new Error(`expected 6:30 PM in slots; got: ${labels.join(", ")}`);
  }
  // 6:45 PM + 30 min = 7:15 PM > 7:00 PM → excluded
  if (labels.includes("6:45 PM")) {
    throw new Error(`6:45 PM should NOT be a slot; got: ${labels.join(", ")}`);
  }
});

test("15-min grid: slots at :00, :15, :30, :45 boundaries", () => {
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
  // All four 15-min boundary slots in the 9:00 AM hour must be present
  if (!labels.includes("9:00 AM"))  throw new Error("expected 9:00 AM");
  if (!labels.includes("9:15 AM"))  throw new Error("expected 9:15 AM");
  if (!labels.includes("9:30 AM"))  throw new Error("expected 9:30 AM");
  if (!labels.includes("9:45 AM"))  throw new Error("expected 9:45 AM");
  if (!labels.includes("10:00 AM")) throw new Error("expected 10:00 AM");
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
  // 2:00 PM is within the 15-min lead buffer (now=14:00, buffer=15min → cutoff=14:15)
  // → filtered because 14:00 < 14:15 (strict <)
  if (labels.includes("2:00 PM")) {
    throw new Error(`2:00 PM should be hidden (within buffer); got: ${labels.join(", ")}`);
  }
  // 2:15 PM: slotStart (14:15) < nowMs+buffer (14:15) → false → NOT filtered → visible
  // 2:30 PM: clearly past the buffer → visible
  if (!labels.includes("2:30 PM")) {
    throw new Error(`expected 2:30 PM (after lead buffer) in slots; got: ${labels.join(", ")}`);
  }
});

// ─── Phase 2: anchor slots ────────────────────────────────────────────────────

test("anchor: 50-min service at 10:00 injects 10:50 AM slot (not on 15-min grid)", () => {
  // Booking 10:00–10:50. With 15-min grid, the next grid slot after the booking
  // would be 11:00. Phase 2 should inject 10:50 so the next customer can start
  // immediately with zero dead time.
  const occStart = new Date(2030, 4, 5, 10, 0, 0, 0);
  const occEnd   = new Date(2030, 4, 5, 10, 50, 0, 0);

  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: "s1",
    staffList: STAFF,
    serviceDurationMinutes: 30,  // new customer books a 30-min service
    occupancy: [
      {
        staff_id: "s1",
        start_time_utc: occStart.toISOString(),
        end_time_utc: occEnd.toISOString(),
      },
    ],
    nowMs: NOW_MS,
  });

  const labels = slots.map((s) => s.label);

  // 10:50 AM is NOT on the 15-min grid (:00/:15/:30/:45) but should be injected
  if (!labels.includes("10:50 AM")) {
    throw new Error(
      `expected anchor slot 10:50 AM (exact booking end); got: ${labels.join(", ")}`,
    );
  }

  // The 10:50 anchor must be available (service 10:50–11:20 doesn't overlap 10:00–10:50)
  const anchor = slots.find((s) => s.label === "10:50 AM");
  assertEqual(anchor?.available, true, "10:50 AM anchor should be available");

  // 10:45 AM is on the 15-min grid but overlaps 10:00–10:50 → still in list, blocked
  const blocked = slots.find((s) => s.label === "10:45 AM");
  if (!blocked) throw new Error("expected 10:45 AM in slots (disabled)");
  assertEqual(blocked.available, false, "10:45 AM overlaps existing booking → unavailable");

  // Slots are in chronological order (anchor inserted in the right position)
  const anchorIdx  = labels.indexOf("10:50 AM");
  const elevenIdx  = labels.indexOf("11:00 AM");
  if (anchorIdx === -1 || elevenIdx === -1) throw new Error("missing expected slots");
  if (anchorIdx >= elevenIdx) {
    throw new Error(`10:50 AM (idx ${anchorIdx}) should come before 11:00 AM (idx ${elevenIdx})`);
  }
});

test("anchor: 45-min Pedicure at 12:00 → 12:45 PM available (user's exact scenario)", () => {
  // This is the exact case the user reported:
  // Client A: Pedicure at 12:00, duration 45 min → end 12:45.
  // With SLOT_STEP=30, the 12:30 slot (12:30–13:15) overlapped → blocked,
  // and the next available was 13:00 (15 min gap).
  // With SLOT_STEP=15, 12:45 falls on the grid (:00/:15/:30/:45) so it
  // appears naturally from Phase 1 — no anchor needed.
  const occStart = new Date(2030, 4, 5, 12, 0, 0, 0);
  const occEnd   = new Date(2030, 4, 5, 12, 45, 0, 0);

  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: "s1",
    staffList: STAFF,
    serviceDurationMinutes: 30,
    occupancy: [
      {
        staff_id: "s1",
        start_time_utc: occStart.toISOString(),
        end_time_utc: occEnd.toISOString(),
      },
    ],
    nowMs: NOW_MS,
  });

  const labels = slots.map((s) => s.label);

  // 12:45 PM is on the 15-min grid and free (12:45–13:15 vs 12:00–12:45 → no overlap)
  if (!labels.includes("12:45 PM")) {
    throw new Error(
      `expected 12:45 PM to be available; got: ${labels.join(", ")}`,
    );
  }
  const slot1245 = slots.find((s) => s.label === "12:45 PM");
  assertEqual(slot1245?.available, true, "12:45 PM should be available");

  // 12:30 PM overlaps 12:00–12:45 → blocked (in list but disabled)
  const slot1230 = slots.find((s) => s.label === "12:30 PM");
  if (!slot1230) throw new Error("expected 12:30 PM in slots");
  assertEqual(slot1230.available, false, "12:30 PM should be blocked (overlaps 12:00–12:45)");
});

test("anchor: not injected when service doesn't fit before close", () => {
  // Hours 9:00–13:00, 55-min service. Booking at 11:55 ends at 12:50.
  // 12:50 + 55 min = 13:45 > 13:00 close → anchor NOT injected.
  const narrowHours = {
    ...HOURS_9_TO_19,
    sun: { open: "09:00", close: "13:00", closed: false },
  };
  const occStart = new Date(2030, 4, 5, 11, 55, 0, 0);
  const occEnd   = new Date(2030, 4, 5, 12, 50, 0, 0);

  const slots = computeTimeSlots({
    openingHoursRaw: narrowHours,
    selectedDate: FUTURE_DATE, // Sunday
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

  const labels = slots.map((s) => s.label);
  if (labels.includes("12:50 PM")) {
    throw new Error(
      `12:50 PM anchor should NOT be injected (55-min service would run past 1:00 PM close); got: ${labels.join(", ")}`,
    );
  }
});

test("anchor: slots are chronologically sorted after injection", () => {
  // Two non-standard bookings: 10:00–10:20 and 11:00–11:35.
  // Anchors at 10:20 and 11:35 should both appear in the correct position.
  const occ1Start = new Date(2030, 4, 5, 10, 0, 0, 0);
  const occ1End   = new Date(2030, 4, 5, 10, 20, 0, 0);
  const occ2Start = new Date(2030, 4, 5, 11, 0, 0, 0);
  const occ2End   = new Date(2030, 4, 5, 11, 35, 0, 0);

  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: "s1",
    staffList: STAFF,
    serviceDurationMinutes: 15,
    occupancy: [
      { staff_id: "s1", start_time_utc: occ1Start.toISOString(), end_time_utc: occ1End.toISOString() },
      { staff_id: "s1", start_time_utc: occ2Start.toISOString(), end_time_utc: occ2End.toISOString() },
    ],
    nowMs: NOW_MS,
  });

  const labels = slots.map((s) => s.label);

  // Both anchors must be present and available
  if (!labels.includes("10:20 AM")) throw new Error("expected anchor 10:20 AM");
  if (!labels.includes("11:35 AM")) throw new Error("expected anchor 11:35 AM");

  const idx1020 = labels.indexOf("10:20 AM");
  const idx1030 = labels.indexOf("10:30 AM");
  const idx1135 = labels.indexOf("11:35 AM");
  const idx1145 = labels.indexOf("11:45 AM");

  // Anchors must appear before the next regular grid slot
  if (idx1020 >= idx1030) throw new Error(`10:20 should come before 10:30`);
  if (idx1135 >= idx1145) throw new Error(`11:35 should come before 11:45`);
});

// ─── Phase 5: Smart Gap-Free Scheduling integration ─────────────────────────

test("Phase 5: perfect gap fill slot gets score 100 and label best_fit", () => {
  // Bookings: 9:00–9:45 and 10:30–11:15. New service: 45 min.
  // Slot 9:45 is a perfect gap fill.
  const occStart1 = new Date(2030, 4, 5, 9,  0, 0, 0);
  const occEnd1   = new Date(2030, 4, 5, 9, 45, 0, 0);
  const occStart2 = new Date(2030, 4, 5, 10, 30, 0, 0);
  const occEnd2   = new Date(2030, 4, 5, 11, 15, 0, 0);

  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: "s1",
    staffList: STAFF,
    serviceDurationMinutes: 45,
    occupancy: [
      { staff_id: "s1", start_time_utc: occStart1.toISOString(), end_time_utc: occEnd1.toISOString() },
      { staff_id: "s1", start_time_utc: occStart2.toISOString(), end_time_utc: occEnd2.toISOString() },
    ],
    nowMs: NOW_MS,
    shortestServiceMinutes: 30,
  });

  const bestFit = slots.find((s) => s.label === "9:45 AM");
  if (!bestFit) throw new Error("expected 9:45 AM in slots");
  assertEqual(bestFit.scoringLabel, "best_fit", "9:45 AM should be best_fit");
  assertEqual(bestFit.score, 100, "perfect gap fill should score 100");
});

test("Phase 5: back-to-back slot gets score 80 and label recommended", () => {
  // Booking: 9:00–9:45. New service: 30 min. Slot 9:45 is back-to-back after.
  const occStart = new Date(2030, 4, 5,  9,  0, 0, 0);
  const occEnd   = new Date(2030, 4, 5,  9, 45, 0, 0);

  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: "s1",
    staffList: STAFF,
    serviceDurationMinutes: 30,
    occupancy: [
      { staff_id: "s1", start_time_utc: occStart.toISOString(), end_time_utc: occEnd.toISOString() },
    ],
    nowMs: NOW_MS,
    shortestServiceMinutes: 30,
  });

  const b2b = slots.find((s) => s.label === "9:45 AM");
  if (!b2b) throw new Error("expected 9:45 AM in slots");
  assertEqual(b2b.scoringLabel, "recommended", "9:45 AM (back-to-back) should be recommended");
  assertEqual(b2b.score, 80);
});

test("Phase 5: dead gap penalty — slot score reduced (label cleared)", () => {
  // B2B after (80) + right dead gap → penalty → score < 80 → label null.
  // Bookings: 9:00–9:45, and 10:50–11:30 (creates 20-min gap after 9:45–10:30 slot).
  const occStart1 = new Date(2030, 4, 5,  9,  0, 0, 0);
  const occEnd1   = new Date(2030, 4, 5,  9, 45, 0, 0);
  const occStart2 = new Date(2030, 4, 5, 10, 50, 0, 0);
  const occEnd2   = new Date(2030, 4, 5, 11, 30, 0, 0);

  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: "s1",
    staffList: STAFF,
    serviceDurationMinutes: 45,   // slot: 9:45–10:30
    occupancy: [
      { staff_id: "s1", start_time_utc: occStart1.toISOString(), end_time_utc: occEnd1.toISOString() },
      { staff_id: "s1", start_time_utc: occStart2.toISOString(), end_time_utc: occEnd2.toISOString() },
    ],
    nowMs: NOW_MS,
    shortestServiceMinutes: 30,
  });

  const penalised = slots.find((s) => s.label === "9:45 AM");
  if (!penalised) throw new Error("expected 9:45 AM in slots");
  if ((penalised.score ?? 0) >= 80) {
    throw new Error(`expected score < 80 after dead-gap penalty; got ${penalised.score}`);
  }
  assertEqual(penalised.scoringLabel, null, "label should be cleared after penalty drops score below 80");
});

test("Phase 5: neutral slots get score 0 with no label", () => {
  // No bookings at all — all slots are neutral.
  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: "s1",
    staffList: STAFF,
    serviceDurationMinutes: 30,
    occupancy: [],
    nowMs: NOW_MS,
    shortestServiceMinutes: 30,
  });

  for (const s of slots) {
    if (s.available && ((s.score ?? 0) !== 0 || s.scoringLabel !== null)) {
      throw new Error(
        `expected neutral score/label on ${s.label}; got score=${s.score}, label=${s.scoringLabel}`,
      );
    }
  }
});

test("Phase 5: neutral slots sort chronologically (score 0 + chronological tiebreaker)", () => {
  // No bookings → all neutral → must stay in time order.
  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: "s1",
    staffList: STAFF,
    serviceDurationMinutes: 30,
    occupancy: [],
    nowMs: NOW_MS,
    shortestServiceMinutes: 30,
  }).filter((s) => s.available);

  for (let i = 1; i < slots.length; i++) {
    const a = slots[i - 1].label;
    const b = slots[i].label;
    // Parse hours from "9:00 AM" style labels for comparison.
    const toMin = (label: string): number => {
      const [time, ampm] = label.split(" ");
      const [h, m] = time.split(":").map(Number);
      const h24 = ampm === "PM" && h !== 12 ? h + 12 : ampm === "AM" && h === 12 ? 0 : h;
      return h24 * 60 + m;
    };
    if (toMin(a) >= toMin(b)) {
      throw new Error(`neutral slots should be chronological: ${a} >= ${b}`);
    }
  }
});

test("Phase 5: best_fit slot sorts BEFORE lower-scored slots", () => {
  // 9:45 AM is a perfect gap fill (score 100). 9:00 AM and 11:00 AM are neutral.
  // After Phase 5 sorting, 9:45 should appear FIRST in the available list.
  const occStart1 = new Date(2030, 4, 5,  9,  0, 0, 0);
  const occEnd1   = new Date(2030, 4, 5,  9, 45, 0, 0);
  const occStart2 = new Date(2030, 4, 5, 10, 30, 0, 0);
  const occEnd2   = new Date(2030, 4, 5, 11, 15, 0, 0);

  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: "s1",
    staffList: STAFF,
    serviceDurationMinutes: 45,
    occupancy: [
      { staff_id: "s1", start_time_utc: occStart1.toISOString(), end_time_utc: occEnd1.toISOString() },
      { staff_id: "s1", start_time_utc: occStart2.toISOString(), end_time_utc: occEnd2.toISOString() },
    ],
    nowMs: NOW_MS,
    shortestServiceMinutes: 30,
  });

  const available = slots.filter((s) => s.available);
  if (available.length === 0) throw new Error("no available slots");
  assertEqual(available[0].label, "9:45 AM", "9:45 AM (best_fit) should be first");
  assertEqual(available[0].scoringLabel, "best_fit");
});

test("Phase 5: valid slots not removed — all slots present (available + disabled)", () => {
  // With or without scoring, every generated slot must still be in the result.
  const before = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: BOOKING_ANY_STAFF_ID,
    staffList: STAFF,
    serviceDurationMinutes: 30,
    occupancy: [],
    nowMs: NOW_MS,
    // No scoring
  });

  const after = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: BOOKING_ANY_STAFF_ID,
    staffList: STAFF,
    serviceDurationMinutes: 30,
    occupancy: [],
    nowMs: NOW_MS,
    shortestServiceMinutes: 30, // With scoring enabled
  });

  assertEqual(before.length, after.length, "scoring must not add or remove slots");
  const beforeLabels = new Set(before.map((s) => s.label));
  for (const s of after) {
    if (!beforeLabels.has(s.label)) {
      throw new Error(`scoring introduced extra slot: ${s.label}`);
    }
  }
});

test("Phase 5: unavailable slots come after available slots in sorted output", () => {
  // One booking occupies 10:00 AM. With scoring, unavailable slots go last.
  const occStart = new Date(2030, 4, 5, 10, 0, 0, 0);
  const occEnd   = new Date(2030, 4, 5, 10, 45, 0, 0);

  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: "s1",
    staffList: STAFF,
    serviceDurationMinutes: 45,
    occupancy: [
      { staff_id: "s1", start_time_utc: occStart.toISOString(), end_time_utc: occEnd.toISOString() },
    ],
    nowMs: NOW_MS,
    shortestServiceMinutes: 30,
  });

  // Find last available and first unavailable in the sorted output.
  const lastAvailIdx = [...slots].reduce(
    (max, s, i) => (s.available ? i : max), -1,
  );
  const firstUnavailIdx = slots.findIndex((s) => !s.available);

  if (firstUnavailIdx !== -1 && lastAvailIdx !== -1) {
    if (firstUnavailIdx < lastAvailIdx) {
      throw new Error(
        `unavailable slot at idx ${firstUnavailIdx} appears before last available at idx ${lastAvailIdx}`,
      );
    }
  }
});

test("Phase 5: no scoring when shortestServiceMinutes omitted (backward compat)", () => {
  // Omitting shortestServiceMinutes should produce score=0 and no labels.
  const occStart = new Date(2030, 4, 5, 9, 0, 0, 0);
  const occEnd   = new Date(2030, 4, 5, 9, 45, 0, 0);

  const slots = computeTimeSlots({
    openingHoursRaw: HOURS_9_TO_19,
    selectedDate: FUTURE_DATE,
    staffId: "s1",
    staffList: STAFF,
    serviceDurationMinutes: 30,
    occupancy: [
      { staff_id: "s1", start_time_utc: occStart.toISOString(), end_time_utc: occEnd.toISOString() },
    ],
    nowMs: NOW_MS,
    // shortestServiceMinutes omitted intentionally
  });

  for (const s of slots) {
    if (s.scoringLabel !== null && s.scoringLabel !== undefined) {
      throw new Error(`expected no scoring label when shortestServiceMinutes omitted; got ${s.scoringLabel} on ${s.label}`);
    }
    if ((s.score ?? 0) !== 0) {
      throw new Error(`expected score 0 when shortestServiceMinutes omitted; got ${s.score} on ${s.label}`);
    }
  }
});

// ─── Trailing buffer may run past close (recover the last slot) ──────────────

test("trailingBufferMinutes lets the SERVICE end at close; buffer may spill past", () => {
  const base = {
    openingHoursRaw: HOURS_9_TO_19, // close 19:00
    selectedDate: FUTURE_DATE,
    staffId: BOOKING_ANY_STAFF_ID,
    staffList: STAFF,
    occupancy: [],
    nowMs: NOW_MS,
  };
  // 60-min service + 5-min buffer → block 65.
  const without = computeTimeSlots({ ...base, serviceDurationMinutes: 65 }).map(
    (s) => s.label,
  );
  const withBuf = computeTimeSlots({
    ...base,
    serviceDurationMinutes: 65,
    trailingBufferMinutes: 5,
  }).map((s) => s.label);

  // Legacy: whole 65-min block must fit → last start 5:45 PM, no 6:00 PM.
  if (without.includes("6:00 PM")) {
    throw new Error(`legacy should exclude 6:00 PM; got: ${without.join(", ")}`);
  }
  // New: service (60) may end exactly at 7:00 close, buffer cleans up after →
  // 6:00 PM is recovered.
  if (!withBuf.includes("6:00 PM")) {
    throw new Error(`expected 6:00 PM recovered; got: ${withBuf.join(", ")}`);
  }
  // But 6:15 PM (service alone would end 7:15) must still be excluded.
  if (withBuf.includes("6:15 PM")) {
    throw new Error(`6:15 PM must stay excluded; got: ${withBuf.join(", ")}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

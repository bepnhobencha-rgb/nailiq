/**
 * Unit tests for Voice AI Group Booking tools — pure logic only.
 *
 * Run: npx tsx src/shared/voiceai/__tests__/groupVoiceTools.test.ts
 *
 * Covers:
 *   1. REALTIME_TOOLS includes get_group_available_slots + confirm_group_booking.
 *   2. Tool argument schema: required fields, enum values.
 *   3. buildSystemPrompt includes group booking rules.
 *   4. groupSchedulerCore primitive behavior (aligned arrangement at anchor).
 *   5. parseHm24 edge cases (inline re-implementation for test isolation).
 *   6. No phone leak: confirm_group_booking hint says "DO NOT read individual assignments".
 */

import crypto from "crypto";
import { REALTIME_TOOLS } from "../realtimeTools";
import { buildSystemPrompt } from "../buildSystemPrompt";
import type { SalonVoiceContext } from "../loadSalonContext";
import {
  tryAlignedArrangement,
  tryFinishAlignedArrangement,
  buildArrangement,
  findFinishArrangementsInWindow,
  SLOT_STEP_MIN,
  type ResolvedMember,
  type StaffRow,
  type ExistingBooking,
  type FinishArrangementsCtx,
} from "../../booking/groupSchedulerCore";

// ─── Minimal test harness ─────────────────────────────────────────

let pass = 0, fail = 0;

function test(name: string, fn: () => void | Promise<void>) {
  const r = (() => {
    try { return fn(); } catch (e) {
      fail++;
      console.error(`✗ ${name}`);
      console.error(e);
      return undefined;
    }
  })();
  if (r instanceof Promise) {
    r.then(() => { pass++; console.log(`✓ ${name}`); })
      .catch((e) => { fail++; console.error(`✗ ${name}`); console.error(e); });
  } else {
    pass++;
    console.log(`✓ ${name}`);
  }
}

function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${msg ?? "assertion failed"}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

function assertTrue(v: unknown, msg?: string) {
  if (!v) throw new Error(`${msg ?? "expected truthy"}\n  actual: ${JSON.stringify(v)}`);
}

function assertFalse(v: unknown, msg?: string) {
  if (v) throw new Error(`${msg ?? "expected falsy"}\n  actual: ${JSON.stringify(v)}`);
}

function assertIncludes(haystack: string, needle: string, msg?: string) {
  if (!haystack.includes(needle)) {
    throw new Error(
      `${msg ?? "string missing expected substring"}\n  needle:   ${needle}\n  haystack: ${haystack.slice(0, 300)}...`,
    );
  }
}

// ─── Re-implemented parseHm24 for isolation ──────────────────────

function parseHm24(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// ─── Fixtures ────────────────────────────────────────────────────

const STAFF: StaffRow[] = [
  { id: "s1", name: "Alice" },
  { id: "s2", name: "Bob" },
  { id: "s3", name: "Carol" },
];
const STAFF_BY_ID = new Map(STAFF.map((s) => [s.id, s]));
const NO_EXISTING: ExistingBooking[] = [];
const NULL_CAPABILITY = null; // all-capable fallback

const PEDICURE_ID = crypto.randomUUID();
const MANICURE_ID = crypto.randomUUID();

// "Day" fixed in UTC: 2030-06-15, open 09:00–20:00
const DAY_OPEN_MS  = new Date("2030-06-15T09:00:00Z").getTime();
const DAY_CLOSE_MS = new Date("2030-06-15T20:00:00Z").getTime();
const TZ = "UTC";

function makeMembers(services: { id: string; mins: number }[]): ResolvedMember[] {
  return services.map((s, i) => ({
    index:           i,
    name:            `Guest ${i + 1}`,
    serviceId:       s.id,
    serviceName:     i < 3 ? "Pedicure" : "Manicure",
    totalMinutes:    s.mins,
    priceCents:      2500,
    preferredStaffId: null,
  }));
}

const THREE_PEDI_TWO_MANI = makeMembers([
  { id: PEDICURE_ID, mins: 60 },
  { id: PEDICURE_ID, mins: 60 },
  { id: PEDICURE_ID, mins: 60 },
  { id: MANICURE_ID, mins: 45 },
  { id: MANICURE_ID, mins: 45 },
]);

// ─── 1. Tool registry ─────────────────────────────────────────────

// REALTIME_TOOLS is "as const" so name is a literal union. Use .some() for includes checks.
const TOOL_NAMES = (REALTIME_TOOLS as unknown as { name: string }[]).map((t) => t.name);

test("REALTIME_TOOLS includes get_group_available_slots", () => {
  assertTrue(TOOL_NAMES.includes("get_group_available_slots"), "tool must be registered");
});

test("REALTIME_TOOLS includes confirm_group_booking", () => {
  assertTrue(TOOL_NAMES.includes("confirm_group_booking"), "tool must be registered");
});

test("REALTIME_TOOLS includes join_waitlist", () => {
  assertTrue(TOOL_NAMES.includes("join_waitlist"), "tool must be registered");
});

test("REALTIME_TOOLS still includes all 5 individual tools", () => {
  for (const expected of [
    "get_available_slots",
    "confirm_booking",
    "find_booking",
    "cancel_booking",
    "reschedule_booking",
  ]) {
    assertTrue(TOOL_NAMES.includes(expected), `missing individual tool: ${expected}`);
  }
  // 5 individual + 2 group (get/confirm) + join_waitlist + end_call
  //   + request_otp + verify_otp (identity gate, #770)
  //   + lookup_customer + leave_message_for_owner (receptionist memory) = 13
  assertEqual(TOOL_NAMES.length, 13, "total tool count must be 13");
});

// ─── 2. Tool schema validation ────────────────────────────────────

test("get_group_available_slots has correct required fields", () => {
  const tool = (REALTIME_TOOLS as unknown as { name: string; parameters: { required: string[] } }[])
    .find((t) => t.name === "get_group_available_slots")!;
  const required = tool.parameters.required;
  assertTrue(required.includes("service_assignments"), "service_assignments required");
  assertTrue(required.includes("date"),                "date required");
  assertTrue(required.includes("target_time"),         "target_time required");
  // mode is optional (defaults to sync_start)
  assertFalse(required.includes("mode"),               "mode should NOT be required (has default)");
});

test("get_group_available_slots mode enum contains sync_start and sync_finish", () => {
  const tool = (REALTIME_TOOLS as unknown as {
    name: string;
    parameters: { properties: Record<string, { enum?: string[] }> };
  }[]).find((t) => t.name === "get_group_available_slots")!;
  const modeEnum = tool.parameters.properties["mode"]?.enum ?? [];
  assertTrue(modeEnum.includes("sync_start"),  "mode must allow sync_start");
  assertTrue(modeEnum.includes("sync_finish"), "mode must allow sync_finish");
  assertEqual(modeEnum.length, 2,              "mode has exactly 2 valid values");
});

test("confirm_group_booking has all required fields", () => {
  const tool = (REALTIME_TOOLS as unknown as { name: string; parameters: { required: string[] } }[])
    .find((t) => t.name === "confirm_group_booking")!;
  const required = tool.parameters.required;
  for (const f of ["service_assignments", "date", "time", "mode", "organizer_name", "organizer_phone"]) {
    assertTrue(required.includes(f), `confirm_group_booking must require: ${f}`);
  }
  // Must NOT require individual member names
  assertFalse(required.includes("member_names"), "must not require individual names");
});

test("confirm_group_booking does not ask for staff_id (voice auto-assigns)", () => {
  const tool = (REALTIME_TOOLS as unknown as {
    name: string;
    parameters: { properties: Record<string, unknown> };
  }[]).find((t) => t.name === "confirm_group_booking")!;
  assertFalse("staff_id" in tool.parameters.properties, "confirm_group_booking must not ask for staff_id");
});

// ─── 3. System prompt rules ───────────────────────────────────────

const MOCK_CTX: SalonVoiceContext = {
  salonId:         crypto.randomUUID(),
  salonName:       "Test Nails",
  timezone:        "America/Vancouver",
  address:         null,
  currency:        "CAD",
  personaName:     "Lily",
  personaVoice:    "marin",
  reasoningEffort: "low",
  businessHours:   null,
  services: [
    { id: PEDICURE_ID, name: "Pedicure", durationMins: 60, priceCents: 2500, price_type: "fixed", price_max_cents: null },
    { id: MANICURE_ID, name: "Manicure", durationMins: 45, priceCents: 2000, price_type: "fixed", price_max_cents: null },
  ],
  staff: [
    { id: "s1", name: "Alice" },
    { id: "s2", name: "Bob" },
  ],
};

const PROMPT_EN = buildSystemPrompt(MOCK_CTX, "en");
const PROMPT_VI = buildSystemPrompt(MOCK_CTX, "vi");

test("system prompt mentions get_group_available_slots", () => {
  assertIncludes(PROMPT_EN, "get_group_available_slots");
  assertIncludes(PROMPT_VI, "get_group_available_slots");
});

test("system prompt mentions confirm_group_booking", () => {
  assertIncludes(PROMPT_EN, "confirm_group_booking");
  assertIncludes(PROMPT_VI, "confirm_group_booking");
});

test("system prompt instructs to default to sync_start when unsure", () => {
  assertIncludes(PROMPT_EN, "sync_start");
});

test("system prompt instructs to NOT read individual assignments aloud", () => {
  // Prompt must say not to read individual staff assignments over voice
  const noAssignments =
    PROMPT_EN.includes("DO NOT read individual") ||
    PROMPT_EN.includes("do NOT describe individual") ||
    PROMPT_EN.includes("Do NOT read individual") ||
    PROMPT_EN.includes("Do not read individual") ||
    PROMPT_EN.includes("party link handles that");
  assertTrue(noAssignments, "prompt must instruct AI not to read individual assignments");
});

test("system prompt says total count per service, not each person's name", () => {
  assertIncludes(PROMPT_EN, "count PER SERVICE TYPE");
});

test("system prompt instructs to use group tools only for 2+ people", () => {
  assertIncludes(PROMPT_EN, "2 or more people");
});

test("system prompt mentions party link sharing after group booking", () => {
  assertIncludes(PROMPT_EN, "party link");
});

// ─── 4. Scheduler core: sync_start ───────────────────────────────

test("tryAlignedArrangement: 3 pedicures + 2 manicures fit on 3 staff at anchor", () => {
  // 5 members, 3 staff → should fail (not enough staff for 5 simultaneous)
  const anchor = DAY_OPEN_MS; // 09:00
  const result = tryAlignedArrangement(
    anchor,
    THREE_PEDI_TWO_MANI,
    STAFF, // 3 staff
    STAFF_BY_ID,
    NULL_CAPABILITY,
    NO_EXISTING,
    false,
  );
  // With 3 staff and 5 members, can't fit all simultaneously → should be null
  assertEqual(result, null, "5 members on 3 staff cannot all start simultaneously");
});

test("tryAlignedArrangement: 3 members fit on 3 staff at anchor", () => {
  const members = makeMembers([
    { id: PEDICURE_ID, mins: 60 },
    { id: PEDICURE_ID, mins: 60 },
    { id: PEDICURE_ID, mins: 60 },
  ]);
  const anchor = DAY_OPEN_MS; // 09:00
  const result = tryAlignedArrangement(
    anchor, members, STAFF, STAFF_BY_ID, NULL_CAPABILITY, NO_EXISTING, false,
  );
  assertTrue(result !== null, "3 members on 3 staff should fit");
  assertEqual(result!.assignments.length, 3, "must have 3 assignments");
  // All start at the same anchor time
  for (const a of result!.assignments) {
    assertEqual(a.startMs, anchor, "all members start at anchor");
  }
});

test("tryAlignedArrangement: blocked by existing booking, returns null", () => {
  const members = makeMembers([
    { id: PEDICURE_ID, mins: 60 },
    { id: PEDICURE_ID, mins: 60 },
    { id: PEDICURE_ID, mins: 60 },
  ]);
  const anchor = DAY_OPEN_MS;
  // All 3 staff are booked at the anchor time
  const blockingBookings: ExistingBooking[] = STAFF.map((s) => ({
    staffId: s.id,
    startMs: anchor,
    endMs:   anchor + 60 * 60_000,
  }));
  const result = tryAlignedArrangement(
    anchor, members, STAFF, STAFF_BY_ID, NULL_CAPABILITY, blockingBookings, false,
  );
  assertEqual(result, null, "should be null when all staff are blocked");
});

test("buildArrangement: correct group start/end and spread", () => {
  const members = makeMembers([
    { id: PEDICURE_ID, mins: 60 },
    { id: MANICURE_ID, mins: 45 },
  ]);
  const anchor = DAY_OPEN_MS;
  const result = tryAlignedArrangement(
    anchor, members, STAFF, STAFF_BY_ID, NULL_CAPABILITY, NO_EXISTING, false,
  );
  assertTrue(result !== null, "arrangement must be found");
  const arr = buildArrangement("best", result!, members, STAFF_BY_ID, TZ);
  assertEqual(arr.kind, "best");
  assertEqual(arr.groupStartMs, anchor, "groupStartMs = anchor");
  // groupEndMs = anchor + max(60, 45) min = anchor + 60 min
  assertEqual(arr.groupEndMs, anchor + 60 * 60_000, "groupEndMs = anchor + 60 min");
  assertEqual(arr.spreadMinutes, 0, "sync_start: all start at same time → 0 spread");
  assertEqual(arr.assignments.length, 2);
});

// ─── 5. Scheduler core: sync_finish ──────────────────────────────

test("tryFinishAlignedArrangement: 2 different-length services finish at same time", () => {
  const members = makeMembers([
    { id: PEDICURE_ID, mins: 60 },
    { id: MANICURE_ID, mins: 45 },
  ]);
  const targetFinishMs = DAY_OPEN_MS + 3 * 60 * 60_000; // 12:00
  // Signature: (targetFinishMs, dayOpenMs, members, staff, staffById, capability, existing, respectPreferred)
  const result = tryFinishAlignedArrangement(
    targetFinishMs, DAY_OPEN_MS,
    members, STAFF, STAFF_BY_ID, NULL_CAPABILITY, NO_EXISTING, false,
  );
  assertTrue(result !== null, "2 members with 2 staff should find a finish arrangement");
  // Pedicure (60 min) should start earlier than manicure (45 min) since both finish at same time
  const pediAssignment = result!.assignments.find((a) => a.memberIdx === 0);
  const maniAssignment = result!.assignments.find((a) => a.memberIdx === 1);
  assertTrue(pediAssignment!.startMs < maniAssignment!.startMs, "longer service starts earlier");
  assertEqual(pediAssignment!.endMs, targetFinishMs, "pedicure ends at target finish");
  assertEqual(maniAssignment!.endMs, targetFinishMs, "manicure ends at target finish");
});

test("findFinishArrangementsInWindow returns arrangements for finish mode", () => {
  const members = makeMembers([
    { id: PEDICURE_ID, mins: 60 },
    { id: MANICURE_ID, mins: 45 },
  ]);
  const finishCtx: FinishArrangementsCtx = {
    targetFinishMs: DAY_OPEN_MS + 3 * 60 * 60_000, // noon
    dayOpenMs:      DAY_OPEN_MS,
    dayCloseMs:     DAY_CLOSE_MS,
    date:           "2030-06-15",
    timezone:       TZ,
    resolvedMembers: members,
    staffList:       STAFF,
    staffById:       STAFF_BY_ID,
    capability:      NULL_CAPABILITY,
    existing:        NO_EXISTING,
  };
  const arrangements = findFinishArrangementsInWindow(finishCtx);
  assertTrue(arrangements.length > 0, "should find at least one finish arrangement");
  // All arrangements should have members ending by or before the target finish time
  for (const arr of arrangements) {
    for (const assignment of arr.assignments) {
      assertTrue(
        Date.parse(assignment.endUtcIso) <= finishCtx.targetFinishMs,
        `member ends at or before target finish: ${assignment.endUtcIso}`,
      );
    }
  }
});

// ─── 6. parseHm24 edge cases ─────────────────────────────────────

test("parseHm24: valid times", () => {
  assertEqual(parseHm24("09:00"), 540,  "09:00 = 540 min");
  assertEqual(parseHm24("14:30"), 870,  "14:30 = 870 min");
  assertEqual(parseHm24("00:00"), 0,    "00:00 = 0 min");
  assertEqual(parseHm24("23:59"), 1439, "23:59 = 1439 min");
  assertEqual(parseHm24("9:30"),  570,  "9:30 = 570 min (no leading zero)");
});

test("parseHm24: invalid times return null", () => {
  assertEqual(parseHm24("25:00"), null, "hour 25 is invalid");
  assertEqual(parseHm24("14:60"), null, "minute 60 is invalid");
  assertEqual(parseHm24("2:00 PM"), null, "12h format not accepted");
  assertEqual(parseHm24(""),     null, "empty string is invalid");
  assertEqual(parseHm24("abc"), null, "non-numeric is invalid");
});

// ─── 7. SLOT_STEP_MIN sanity ─────────────────────────────────────

test("SLOT_STEP_MIN is 15 (group scheduler granularity)", () => {
  assertEqual(SLOT_STEP_MIN, 15, "slots must be in 15-min increments");
});

// ─── Summary ──────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}, 200);

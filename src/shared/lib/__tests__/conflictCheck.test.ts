import { checkBookingConflict, type ConflictCheckBooking } from "../conflictCheck";

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

function booking(partial: Partial<ConflictCheckBooking> & Pick<ConflictCheckBooking, "id">): ConflictCheckBooking {
  return {
    staff_id: "s1",
    start_time_utc: "2026-05-02T22:00:00.000Z",
    end_time_utc: "2026-05-02T22:30:00.000Z",
    status: "confirmed",
    client_name: "A",
    ...partial,
  };
}

test("no conflict — empty bookings", () => {
  const result = checkBookingConflict({
    staffId: "s1",
    startUtcIso: "2026-05-02T22:00:00.000Z",
    endUtcIso: "2026-05-02T22:30:00.000Z",
    existingBookings: [],
  });
  assertEqual(result, null);
});

test("exact overlap — same staff, same range → conflict", () => {
  const existing = booking({ id: "b1" });
  const result = checkBookingConflict({
    staffId: "s1",
    startUtcIso: "2026-05-02T22:00:00.000Z",
    endUtcIso: "2026-05-02T22:30:00.000Z",
    existingBookings: [existing],
  });
  assertEqual(result?.id, "b1");
});

test("partial overlap start — new starts inside existing → conflict", () => {
  const existing = booking({ id: "b2" });
  const result = checkBookingConflict({
    staffId: "s1",
    startUtcIso: "2026-05-02T22:15:00.000Z",
    endUtcIso: "2026-05-02T22:45:00.000Z",
    existingBookings: [existing],
  });
  assertEqual(result?.id, "b2");
});

test("partial overlap end — new ends inside existing → conflict", () => {
  const existing = booking({ id: "b3" });
  const result = checkBookingConflict({
    staffId: "s1",
    startUtcIso: "2026-05-02T21:45:00.000Z",
    endUtcIso: "2026-05-02T22:15:00.000Z",
    existingBookings: [existing],
  });
  assertEqual(result?.id, "b3");
});

test("new contains existing — wraps fully → conflict", () => {
  const existing = booking({ id: "b4" });
  const result = checkBookingConflict({
    staffId: "s1",
    startUtcIso: "2026-05-02T21:00:00.000Z",
    endUtcIso: "2026-05-02T23:00:00.000Z",
    existingBookings: [existing],
  });
  assertEqual(result?.id, "b4");
});

test("adjacent — new starts exactly at existing.end → NO conflict", () => {
  const existing = booking({ id: "b5" });
  const result = checkBookingConflict({
    staffId: "s1",
    startUtcIso: "2026-05-02T22:30:00.000Z",
    endUtcIso: "2026-05-02T23:00:00.000Z",
    existingBookings: [existing],
  });
  assertEqual(result, null);
});

test("different staff, overlapping time → NO conflict", () => {
  const existing = booking({ id: "b6", staff_id: "s2" });
  const result = checkBookingConflict({
    staffId: "s1",
    startUtcIso: "2026-05-02T22:00:00.000Z",
    endUtcIso: "2026-05-02T22:30:00.000Z",
    existingBookings: [existing],
  });
  assertEqual(result, null);
});

test("cancelled status existing → NO conflict", () => {
  const existing = booking({ id: "b7", status: "cancelled" });
  const result = checkBookingConflict({
    staffId: "s1",
    startUtcIso: "2026-05-02T22:00:00.000Z",
    endUtcIso: "2026-05-02T22:30:00.000Z",
    existingBookings: [existing],
  });
  assertEqual(result, null);
});

test("Null staff_id existing → skipped → NO conflict", () => {
  const existing = booking({ id: "b8", staff_id: null });
  const result = checkBookingConflict({
    staffId: "s1",
    startUtcIso: "2026-05-02T22:00:00.000Z",
    endUtcIso: "2026-05-02T22:30:00.000Z",
    existingBookings: [existing],
  });
  assertEqual(result, null);
});

test("Excluded booking ID → skipped → NO conflict", () => {
  const existing = booking({ id: "b9" });
  const result = checkBookingConflict({
    staffId: "s1",
    startUtcIso: "2026-05-02T22:00:00.000Z",
    endUtcIso: "2026-05-02T22:30:00.000Z",
    existingBookings: [existing],
    excludeBookingId: "b9",
  });
  assertEqual(result, null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

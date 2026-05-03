import { isWalkinUrgent, minutesWaiting } from "../queueUrgency";

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

const joined = "2026-05-02T10:00:00.000Z";

test("Waited 5 min, no note → not urgent", () => {
  const nowIso = "2026-05-02T10:05:00.000Z";
  assertEqual(minutesWaiting(joined, nowIso), 5);
  assertEqual(
    isWalkinUrgent({
      joinedQueueAtIso: joined,
      staffRequestNote: null,
      nowIso,
    }),
    false,
  );
});

test("Waited 25 min, no note → urgent", () => {
  const nowIso = "2026-05-02T10:25:00.000Z";
  assertEqual(minutesWaiting(joined, nowIso), 25);
  assertEqual(
    isWalkinUrgent({
      joinedQueueAtIso: joined,
      staffRequestNote: null,
      nowIso,
    }),
    true,
  );
});

test("Waited 5 min, note \"khách vội\" → urgent", () => {
  const nowIso = "2026-05-02T10:05:00.000Z";
  assertEqual(
    isWalkinUrgent({
      joinedQueueAtIso: joined,
      staffRequestNote: "khách vội",
      nowIso,
    }),
    true,
  );
});

test("Waited 5 min, note \"Yêu cầu Mai\" → not urgent", () => {
  const nowIso = "2026-05-02T10:05:00.000Z";
  assertEqual(
    isWalkinUrgent({
      joinedQueueAtIso: joined,
      staffRequestNote: "Yêu cầu Mai",
      nowIso,
    }),
    false,
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

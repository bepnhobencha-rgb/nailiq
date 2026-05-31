/**
 * Unit tests for Basic Mode cockpit logic (deterministic Next Action +
 * Critical Alerts, config-driven).
 *
 * Run: npx tsx src/shared/dashboard/__tests__/basicModeCockpit.test.ts
 */

import {
  computeNextAction,
  computeCriticalAlerts,
  type CockpitInputs,
  type CockpitLabels,
} from "../basicModeCockpit";

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
    throw new Error(`${msg ?? "assertEqual"}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

const labels: CockpitLabels = {
  longWaitGuest: (n) => `longwait:${n}`,
  finishOverdue: (n) => `overdue:${n}`,
  assignWaiting: (n) => `assignN:${n}`,
  assignWaitingNamed: (name) => `assign:${name}`,
  prepareNext: (n) => `prepare:${n}`,
  partyPendingNamed: (when, name) => `party-named:${when}:${name}`,
  partyPendingCount: (when, n) => `party-count:${when}:${n}`,
  partyPendingChanges: (when, n) => `party-changes:${when}:${n}`,
  suggestWalkin: (name) => `suggest:${name}`,
  actionOpenQueue: "OpenQueue",
  actionAddWalkin: "+Walkin",
  actionOpenParty: "OpenParty",
  actionOpenBooking: "OpenBooking",
  alertOverdue: (n) => `a-overdue:${n}`,
  alertOverdueNamed: (name, time) => `a-overdue-named:${name}:${time}`,
  alertLongWait: (n) => `a-longwait:${n}`,
  alertNoStaffForWaiting: "a-nostaff",
  alertSmsFailed: (n) => `a-sms:${n}`,
  alertSetupIncomplete: "a-setup",
};

const base: CockpitInputs = {
  waitingCount: 0,
  inProgressCount: 0,
  comingUpCount: 0,
  overdueCount: 0,
  longestWaitMinutes: null,
  availableStaffCount: 0,
  availableStaffName: null,
  firstWaitingName: null,
  firstOverdueName: null,
  firstOverdueTimeLabel: null,
  smsFailedCount: 0,
  pendingPartyCount: 0,
  pendingPartyChangeCount: 0,
  pendingPartyWhen: null,
  pendingPartyGuestName: null,
  isSetupIncomplete: false,
};

// ── Next Action priority (risk-first, deterministic) ────────────

test("long-wait guest is the top priority", () => {
  const a = computeNextAction(
    { ...base, longestWaitMinutes: 15, overdueCount: 2, waitingCount: 3 },
    labels,
  );
  assertEqual(a?.kind, "long_wait");
  assertEqual(a?.text, "longwait:15");
  assertEqual(a?.action?.target, "open_queue");
});

test("long-wait does NOT trigger at/below threshold (default 10)", () => {
  const a = computeNextAction({ ...base, longestWaitMinutes: 10, comingUpCount: 1 }, labels);
  assertEqual(a?.kind, "prepare_next");
});

test("overdue wins when no long-wait → opens the booking (not queue)", () => {
  const a = computeNextAction({ ...base, overdueCount: 1, waitingCount: 2 }, labels);
  assertEqual(a?.kind, "finish_overdue");
  assertEqual(a?.action?.target, "open_overdue");
});

test("single overdue uses named copy + open_overdue in alerts", () => {
  const r = computeCriticalAlerts(
    { ...base, overdueCount: 1, firstOverdueName: "Carol", firstOverdueTimeLabel: "3:00 PM" },
    labels,
  );
  assertEqual(r.shown[0]!.key, "overdue");
  assertEqual(r.shown[0]!.text, "a-overdue-named:Carol:3:00 PM");
  assertEqual(r.shown[0]!.action?.target, "open_overdue");
});

test("multiple overdue uses count copy", () => {
  const r = computeCriticalAlerts({ ...base, overdueCount: 3 }, labels);
  assertEqual(r.shown[0]!.text, "a-overdue:3");
  assertEqual(r.shown[0]!.action?.target, "open_overdue");
});

test("waiting guest (named) when no overdue", () => {
  const a = computeNextAction({ ...base, waitingCount: 2, firstWaitingName: "Mai" }, labels);
  assertEqual(a?.kind, "assign_waiting");
  assertEqual(a?.text, "assign:Mai");
});

test("upcoming is informational (no action button)", () => {
  const a = computeNextAction({ ...base, comingUpCount: 3 }, labels);
  assertEqual(a?.kind, "prepare_next");
  assertEqual(a?.action, null);
});

test("party pending after upcoming (uses when + count copy)", () => {
  const a = computeNextAction(
    { ...base, pendingPartyCount: 3, pendingPartyWhen: "Today 5:00 PM" },
    labels,
  );
  assertEqual(a?.kind, "party_pending");
  assertEqual(a?.text, "party-count:Today 5:00 PM:3");
  assertEqual(a?.action?.target, "open_party");
});

test("single party pending uses named copy", () => {
  const a = computeNextAction(
    { ...base, pendingPartyCount: 1, pendingPartyWhen: "Today 5:00 PM", pendingPartyGuestName: "Huy" },
    labels,
  );
  assertEqual(a?.text, "party-named:Today 5:00 PM:Huy");
});

test("upcoming (not today) party still fires with its own 'when'", () => {
  const a = computeNextAction(
    { ...base, pendingPartyCount: 4, pendingPartyWhen: "Tomorrow 10:00 AM" },
    labels,
  );
  assertEqual(a?.kind, "party_pending");
  assertEqual(a?.text, "party-count:Tomorrow 10:00 AM:4");
});

test("party with only a pending CHANGE request (0 unconfirmed) still fires", () => {
  const a = computeNextAction(
    { ...base, pendingPartyChangeCount: 2, pendingPartyWhen: "Sat, May 31 · 10:00 AM" },
    labels,
  );
  assertEqual(a?.kind, "party_pending");
  assertEqual(a?.text, "party-changes:Sat, May 31 · 10:00 AM:2");
});

test("party pending without a 'when' phrase does NOT fire", () => {
  const a = computeNextAction({ ...base, pendingPartyCount: 2 }, labels);
  assertEqual(a, null);
});

test("available staff + empty queue → suggest walk-in", () => {
  const a = computeNextAction({ ...base, availableStaffName: "Anna" }, labels);
  assertEqual(a?.kind, "suggest_walkin");
  assertEqual(a?.text, "suggest:Anna");
  assertEqual(a?.action?.target, "add_walkin");
});

test("returns null when nothing useful — no 'all clear' filler", () => {
  assertEqual(computeNextAction(base, labels), null);
});

test("deterministic — same input twice yields identical output", () => {
  const input = { ...base, overdueCount: 1 };
  assertEqual(computeNextAction(input, labels), computeNextAction(input, labels));
});

// ── Critical Alerts (max 2 + overflow, risk-first) ──────────────

test("no alerts when all clear → empty + zero overflow", () => {
  assertEqual(computeCriticalAlerts(base, labels), { shown: [], overflowCount: 0 });
});

test("overdue + long-wait are the top two; rest overflow", () => {
  const r = computeCriticalAlerts(
    {
      ...base,
      overdueCount: 1,
      longestWaitMinutes: 20,
      pendingPartyCount: 2,
      pendingPartyWhen: "Today 5:00 PM",
      smsFailedCount: 1,
      isSetupIncomplete: true,
    },
    labels,
  );
  assertEqual(r.shown.length, 2, "capped at 2");
  assertEqual(r.shown[0]!.key, "overdue");
  assertEqual(r.shown[1]!.key, "long_wait");
  assertEqual(r.overflowCount, 3, "3 collapsed into +N");
});

test("no-staff-for-waiting bottleneck surfaces as alert", () => {
  const r = computeCriticalAlerts(
    { ...base, waitingCount: 2, availableStaffCount: 0 },
    labels,
  );
  assertEqual(r.shown.length, 1);
  assertEqual(r.shown[0]!.key, "no_staff_for_waiting");
});

test("party pending surfaces as alert with open_party + named copy", () => {
  const r = computeCriticalAlerts(
    { ...base, pendingPartyCount: 1, pendingPartyWhen: "Today 5:00 PM", pendingPartyGuestName: "Huy" },
    labels,
  );
  assertEqual(r.shown[0]!.key, "party_change");
  assertEqual(r.shown[0]!.text, "party-named:Today 5:00 PM:Huy");
  assertEqual(r.shown[0]!.action?.target, "open_party");
});

// ── Dedupe: a shown Critical Alert suppresses the matching Next Action ──

test("overdue shown as alert → Next Action does NOT duplicate it", () => {
  const input = { ...base, overdueCount: 1 };
  const alerts = computeCriticalAlerts(input, labels);
  const action = computeNextAction(input, labels, alerts.shown.map((a) => a.key));
  // Only the overdue issue exists → no non-duplicated action remains → hidden.
  assertEqual(action, null);
});

test("long-wait shown as alert → Next Action falls through to next useful action", () => {
  // Long-wait (alert) + an upcoming booking → Next Action skips long_wait and
  // surfaces the non-duplicated 'prepare_next' instead.
  const input = { ...base, longestWaitMinutes: 15, comingUpCount: 2 };
  const alerts = computeCriticalAlerts(input, labels);
  assertEqual(alerts.shown[0]!.key, "long_wait");
  const action = computeNextAction(input, labels, alerts.shown.map((a) => a.key));
  assertEqual(action?.kind, "prepare_next");
});

test("party alert → party_pending Next Action suppressed; walk-in surfaces", () => {
  const input = {
    ...base,
    pendingPartyCount: 2,
    pendingPartyWhen: "Today 5:00 PM",
    availableStaffName: "Anna",
  };
  const alerts = computeCriticalAlerts(input, labels);
  const action = computeNextAction(input, labels, alerts.shown.map((a) => a.key));
  assertEqual(action?.kind, "suggest_walkin");
});

test("no alert → Next Action is unaffected (back-compat default arg)", () => {
  const a = computeNextAction({ ...base, availableStaffName: "Anna" }, labels);
  assertEqual(a?.kind, "suggest_walkin");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

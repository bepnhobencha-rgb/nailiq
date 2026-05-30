/**
 * Unit tests for Basic Mode cockpit logic (deterministic Next Action +
 * Critical Alerts).
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
  finishOverdue: (n) => `overdue:${n}`,
  assignWalkin: (name) => `assign:${name}`,
  assignWalkinGeneric: "assign:generic",
  prepareNext: (n) => `prepare:${n}`,
  alertOverdue: (n) => `a-overdue:${n}`,
  alertSmsFailed: (n) => `a-sms:${n}`,
  alertPartyChange: (n) => `a-party:${n}`,
  alertLongWait: (n) => `a-wait:${n}`,
  alertSetupIncomplete: "a-setup",
};

const base: CockpitInputs = {
  waitingCount: 0,
  inProgressCount: 0,
  comingUpCount: 0,
  overdueCount: 0,
  avgWaitMinutes: null,
  firstWaitingName: null,
  smsFailedCount: 0,
  pendingPartyChangeCount: 0,
  isSetupIncomplete: false,
};

// ── Next Action priority (risk-first, deterministic) ────────────

test("overdue wins over everything", () => {
  const a = computeNextAction(
    { ...base, overdueCount: 2, waitingCount: 3, comingUpCount: 4 },
    labels,
  );
  assertEqual(a?.kind, "finish_overdue");
  assertEqual(a?.text, "overdue:2");
  assertEqual(a?.tone, "danger");
});

test("waiting walk-in wins when no overdue (uses first name)", () => {
  const a = computeNextAction(
    { ...base, waitingCount: 2, firstWaitingName: "Mai", comingUpCount: 5 },
    labels,
  );
  assertEqual(a?.kind, "assign_walkin");
  assertEqual(a?.text, "assign:Mai");
});

test("waiting walk-in falls back to generic without a name", () => {
  const a = computeNextAction({ ...base, waitingCount: 1 }, labels);
  assertEqual(a?.text, "assign:generic");
});

test("coming up wins when no overdue + no waiting", () => {
  const a = computeNextAction({ ...base, comingUpCount: 3 }, labels);
  assertEqual(a?.kind, "prepare_next");
  assertEqual(a?.text, "prepare:3");
});

test("returns null (hidden) when nothing pending — no 'all clear' filler", () => {
  assertEqual(computeNextAction(base, labels), null);
});

test("deterministic — same input twice yields identical output", () => {
  const input = { ...base, overdueCount: 1 };
  assertEqual(computeNextAction(input, labels), computeNextAction(input, labels));
});

// ── Critical Alerts (max 2, risk-first) ─────────────────────────

test("no alerts when all clear", () => {
  assertEqual(computeCriticalAlerts(base, labels), []);
});

test("overdue + sms_failed are the top two (drops softer signals)", () => {
  const alerts = computeCriticalAlerts(
    {
      ...base,
      overdueCount: 1,
      smsFailedCount: 2,
      isSetupIncomplete: true,
      avgWaitMinutes: 40,
    },
    labels,
  );
  assertEqual(alerts.length, 2, "capped at 2");
  assertEqual(alerts[0]!.key, "overdue");
  assertEqual(alerts[1]!.key, "sms_failed");
});

test("never exceeds 2 alerts", () => {
  const alerts = computeCriticalAlerts(
    { ...base, smsFailedCount: 1, isSetupIncomplete: true, avgWaitMinutes: 30 },
    labels,
  );
  assertEqual(alerts.length, 2);
});

test("party change request surfaces as a critical alert", () => {
  const alerts = computeCriticalAlerts(
    { ...base, pendingPartyChangeCount: 2 },
    labels,
  );
  assertEqual(alerts.length, 1);
  assertEqual(alerts[0]!.key, "party_change");
  assertEqual(alerts[0]!.text, "a-party:2");
});

test("long wait only triggers above threshold", () => {
  assertEqual(computeCriticalAlerts({ ...base, avgWaitMinutes: 20 }, labels), []);
  const over = computeCriticalAlerts({ ...base, avgWaitMinutes: 21 }, labels);
  assertEqual(over.length, 1);
  assertEqual(over[0]!.key, "long_wait");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

/**
 * Unit tests for the requireReleaseFeatureEnabled gate (PR3).
 *
 * Run: npx tsx src/shared/features/__tests__/requireReleaseFeature.test.ts
 *
 * The real helper hits Supabase + auth, so this test exercises the pure
 * decision logic it delegates to (isReleaseFeatureEnabled) for the exact
 * salon shapes the helper would resolve, plus a tiny re-implementation of the
 * helper's branch order to pin: unauthorized → salon_not_found →
 * feature_not_enabled → ok.
 */

import {
  isReleaseFeatureEnabled,
  type ReleaseFeatureKey,
} from "@/shared/features/featureRegistry";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n  ${(e as Error).message}`);
  }
}
function eq<T>(a: T, b: T, msg: string) {
  if (a !== b) throw new Error(`${msg} — expected ${String(b)}, got ${String(a)}`);
}

type SalonRow = {
  id: string;
  subscription_plan: string | null;
  plan_override: string | null;
  feature_flags: unknown;
  voice_ai_enabled: boolean | null;
} | null;

// Mirror of requireReleaseFeatureEnabled's branch order, with DB/auth injected.
function decide(
  resolved: boolean,
  row: SalonRow,
  key: ReleaseFeatureKey,
): "unauthorized" | "salon_not_found" | "feature_not_enabled" | "ok" {
  if (!resolved) return "unauthorized";
  if (!row) return "salon_not_found";
  return isReleaseFeatureEnabled(row, key) ? "ok" : "feature_not_enabled";
}

const baseRow: NonNullable<SalonRow> = {
  id: "s1",
  subscription_plan: "free",
  plan_override: null,
  feature_flags: {},
  voice_ai_enabled: null,
};

test("unauthorized when not resolved", () => {
  eq(decide(false, null, "loyalty"), "unauthorized", "no auth");
});

test("salon_not_found when row missing", () => {
  eq(decide(true, null, "loyalty"), "salon_not_found", "row null");
});

test("feature_not_enabled for Beta flag OFF by default", () => {
  eq(decide(true, baseRow, "loyalty"), "feature_not_enabled", "loyalty default OFF");
  eq(decide(true, baseRow, "combos"), "feature_not_enabled", "combos default OFF");
  eq(decide(true, baseRow, "advanced_reports"), "feature_not_enabled", "reports default OFF");
  eq(decide(true, baseRow, "group_booking"), "feature_not_enabled", "group default OFF");
  eq(decide(true, baseRow, "ai_control_center"), "feature_not_enabled", "AI Control Center default OFF");
});

test("ok when jsonb flag is enabled", () => {
  const row = { ...baseRow, feature_flags: { loyalty_enabled: true } };
  eq(decide(true, row, "loyalty"), "ok", "loyalty enabled via flag");
});

test("ok when reports/group flags enabled", () => {
  const row = {
    ...baseRow,
    feature_flags: { reports_enabled: true, group_booking_enabled: true },
  };
  eq(decide(true, row, "advanced_reports"), "ok", "reports on");
  eq(decide(true, row, "group_booking"), "ok", "group on");
});

test("AI Control Center requires its explicit JSONB flag", () => {
  const row = {
    ...baseRow,
    feature_flags: { ai_control_center_enabled: true },
  };
  eq(decide(true, row, "ai_control_center"), "ok", "AI Control Center on");
});

test("plan-sourced photos: pro plan ok, free not", () => {
  eq(decide(true, { ...baseRow, subscription_plan: "pro" }, "photos"), "ok", "pro photos");
  eq(decide(true, baseRow, "photos"), "feature_not_enabled", "free photos");
});

test("ai_voice resolves from voice_ai_enabled column", () => {
  eq(decide(true, { ...baseRow, voice_ai_enabled: true }, "ai_voice"), "ok", "voice on");
  eq(decide(true, baseRow, "ai_voice"), "feature_not_enabled", "voice off");
});

test("Base feature is always ok (default ON)", () => {
  eq(decide(true, baseRow, "receptionist_center"), "ok", "base default ON");
  eq(decide(true, baseRow, "public_booking"), "ok", "base default ON");
});

console.log(`\nrequireReleaseFeature: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

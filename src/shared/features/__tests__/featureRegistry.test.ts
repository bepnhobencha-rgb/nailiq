/**
 * Unit tests for the release feature registry + resolver.
 *
 * Run: npx tsx src/shared/features/__tests__/featureRegistry.test.ts
 *
 * Covers: default-without-DB-row, jsonb override precedence, the voice_ai
 * column source, billing-plan reuse, and registry integrity (Base ON / Beta
 * OFF, no key collisions with the existing SuperAdmin flag list).
 */

import {
  RELEASE_FEATURES,
  RELEASE_FEATURE_KEYS,
  BASE_FEATURE_KEYS,
  BETA_FEATURE_KEYS,
  isReleaseFeatureEnabled,
  releaseFeatureDefault,
} from "../featureRegistry";

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
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
function eq<T>(a: T, b: T, msg: string) {
  if (a !== b) throw new Error(`${msg} — expected ${String(b)}, got ${String(a)}`);
}

// ── Defaults without any DB row ──────────────────────────────────────────
test("Base features default ON with empty salon", () => {
  for (const k of BASE_FEATURE_KEYS) {
    eq(isReleaseFeatureEnabled({}, k), true, `${k} should default ON`);
  }
});

test("Beta features default OFF with empty salon", () => {
  for (const k of BETA_FEATURE_KEYS) {
    eq(isReleaseFeatureEnabled({}, k), false, `${k} should default OFF`);
  }
});

test("releaseFeatureDefault matches phase", () => {
  for (const k of RELEASE_FEATURE_KEYS) {
    const d = RELEASE_FEATURES[k];
    eq(releaseFeatureDefault(k), d.phase === "base", `${k} default vs phase`);
  }
});

// ── jsonb override precedence ────────────────────────────────────────────
test("jsonb override turns a Base feature OFF", () => {
  // receptionist_center → feature_flags.receptionist_center_enabled
  eq(
    isReleaseFeatureEnabled(
      { feature_flags: { receptionist_center_enabled: false } },
      "receptionist_center",
    ),
    false,
    "explicit false override wins over Base default ON",
  );
});

test("jsonb override turns a Beta feature ON", () => {
  // group_booking → feature_flags.group_booking_enabled
  eq(
    isReleaseFeatureEnabled(
      { feature_flags: { group_booking_enabled: true } },
      "group_booking",
    ),
    true,
    "explicit true override wins over Beta default OFF",
  );
});

test("non-boolean jsonb value falls back to default", () => {
  eq(
    isReleaseFeatureEnabled(
      { feature_flags: { group_booking_enabled: "yes" as unknown as boolean } },
      "group_booking",
    ),
    false,
    "string flag value is ignored → Beta default OFF",
  );
  eq(
    isReleaseFeatureEnabled({ feature_flags: null }, "walkin_queue"),
    true,
    "null feature_flags → Base default ON",
  );
});

// ── column source (Voice AI) ─────────────────────────────────────────────
test("ai_voice reads the voice_ai_enabled column", () => {
  eq(isReleaseFeatureEnabled({ voice_ai_enabled: true }, "ai_voice"), true, "column true");
  eq(isReleaseFeatureEnabled({ voice_ai_enabled: false }, "ai_voice"), false, "column false");
  eq(isReleaseFeatureEnabled({}, "ai_voice"), false, "missing column → Beta default OFF");
});

// ── plan source (billing reuse, read-only) ───────────────────────────────
test("photos resolves via plan: pro plan enables, free disables", () => {
  eq(
    isReleaseFeatureEnabled(
      { subscription_plan: "pro", plan_override: null, feature_flags: {} },
      "photos",
    ),
    true,
    "pro plan includes photo_confirmation",
  );
  eq(
    isReleaseFeatureEnabled(
      { subscription_plan: "free", plan_override: null, feature_flags: {} },
      "photos",
    ),
    false,
    "free plan excludes photo_confirmation",
  );
});

test("plan-sourced feature still honours a feature_flags override (via hasFeature)", () => {
  eq(
    isReleaseFeatureEnabled(
      { subscription_plan: "free", feature_flags: { photo_confirmation: true } },
      "photos",
    ),
    true,
    "explicit photo_confirmation flag overrides free plan",
  );
});

// ── registry integrity ───────────────────────────────────────────────────
test("every key's descriptor.key matches its map key", () => {
  for (const k of RELEASE_FEATURE_KEYS) {
    eq(RELEASE_FEATURES[k].key, k, `descriptor.key mismatch for ${k}`);
  }
});

test("Base = 10 keys, Beta = 10 keys, all ON/OFF respectively", () => {
  eq(BASE_FEATURE_KEYS.length, 10, "Base count");
  eq(BETA_FEATURE_KEYS.length, 10, "Beta count");
  assert(
    BASE_FEATURE_KEYS.every((k) => RELEASE_FEATURES[k].defaultOn === true),
    "all Base defaultOn true",
  );
  assert(
    BETA_FEATURE_KEYS.every((k) => RELEASE_FEATURES[k].defaultOn === false),
    "all Beta defaultOn false",
  );
});

test("mapped jsonb/column/plan keys match the known existing keys", () => {
  const expected: Record<string, string> = {
    receptionist_center: "jsonb:receptionist_center_enabled",
    walkin_queue: "jsonb:walkin_queue_enabled",
    group_booking: "jsonb:group_booking_enabled",
    loyalty: "jsonb:loyalty_enabled",
    advanced_reports: "jsonb:reports_enabled",
    ai_voice: "column:voice_ai_enabled",
    photos: "plan:photo_confirmation",
    reviews: "plan:reviews",
  };
  for (const [key, want] of Object.entries(expected)) {
    const s = RELEASE_FEATURES[key as keyof typeof RELEASE_FEATURES].source;
    const got =
      s.kind === "jsonb"
        ? `jsonb:${s.flagKey}`
        : s.kind === "column"
          ? `column:${s.column}`
          : s.kind === "plan"
            ? `plan:${s.planFeature}`
            : "registry";
    eq(got, want, `mapping for ${key}`);
  }
});

console.log(`\nfeatureRegistry: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

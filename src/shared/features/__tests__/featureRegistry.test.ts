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
  releaseFeatureUiGroup,
  describeReleaseFeatureForSalon,
  describeReleaseFeaturesForSalon,
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

// ── describeReleaseFeatureForSalon (read-only SuperAdmin panel helper) ────
test("describe: jsonb override ON surfaces resolved ON + overridden", () => {
  // group_booking (Beta, default OFF) forced ON via feature_flags
  const row = describeReleaseFeatureForSalon(
    { feature_flags: { group_booking_enabled: true } },
    "group_booking",
  );
  eq(row.resolved, true, "resolved ON");
  eq(row.defaultOn, false, "default OFF");
  eq(row.source, "jsonb", "jsonb source");
  eq(row.overridden, true, "diverges from default → overridden");
});

test("describe: jsonb override OFF surfaces resolved OFF + overridden", () => {
  // receptionist_center (Base, default ON) forced OFF via feature_flags
  const row = describeReleaseFeatureForSalon(
    { feature_flags: { receptionist_center_enabled: false } },
    "receptionist_center",
  );
  eq(row.resolved, false, "resolved OFF");
  eq(row.defaultOn, true, "default ON");
  eq(row.source, "jsonb", "jsonb source");
  eq(row.overridden, true, "diverges from default → overridden");
});

test("describe: no override matches the default and is not flagged overridden", () => {
  const base = describeReleaseFeatureForSalon({}, "public_booking");
  eq(base.resolved, true, "Base default ON");
  eq(base.overridden, false, "no divergence");
  const beta = describeReleaseFeatureForSalon({}, "marketing");
  eq(beta.resolved, false, "Beta default OFF");
  eq(beta.overridden, false, "no divergence");
});

test("describe: column source (voice) reflects the voice_ai_enabled column", () => {
  const on = describeReleaseFeatureForSalon({ voice_ai_enabled: true }, "ai_voice");
  eq(on.source, "column", "column source");
  eq(on.resolved, true, "column true → ON");
  eq(on.overridden, true, "ON diverges from Beta default OFF");
  const missing = describeReleaseFeatureForSalon({}, "ai_voice");
  eq(missing.resolved, false, "missing column → Beta default OFF");
  eq(missing.overridden, false, "matches default");
});

test("describe: plan source (reviews/photos) reflects the billing plan", () => {
  const reviewsPro = describeReleaseFeatureForSalon(
    { subscription_plan: "pro", plan_override: null, feature_flags: {} },
    "reviews",
  );
  eq(reviewsPro.source, "plan", "plan source");
  eq(reviewsPro.resolved, true, "pro plan includes reviews");
  eq(reviewsPro.overridden, true, "ON diverges from Beta default OFF");
  const photosFree = describeReleaseFeatureForSalon(
    { subscription_plan: "free", plan_override: null, feature_flags: {} },
    "photos",
  );
  eq(photosFree.source, "plan", "plan source");
  eq(photosFree.resolved, false, "free plan excludes photos");
  eq(photosFree.overridden, false, "matches Beta default OFF");
});

test("describe: registry default source resolves from defaultOn only", () => {
  const row = describeReleaseFeatureForSalon({}, "combos");
  eq(row.source, "registry", "registry source");
  eq(row.resolved, false, "Beta registry default OFF");
  eq(row.overridden, false, "no override possible");
});

// ── UI grouping: Base / Beta / Plan-Column ────────────────────────────────
test("releaseFeatureUiGroup: plan & column features land in plan_column", () => {
  eq(releaseFeatureUiGroup("ai_voice"), "plan_column", "column → plan_column");
  eq(releaseFeatureUiGroup("reviews"), "plan_column", "plan → plan_column");
  eq(releaseFeatureUiGroup("photos"), "plan_column", "plan → plan_column");
  eq(releaseFeatureUiGroup("public_booking"), "base", "Base registry → base");
  eq(
    releaseFeatureUiGroup("receptionist_center"),
    "base",
    "Base jsonb → base",
  );
  eq(releaseFeatureUiGroup("group_booking"), "beta", "Beta jsonb → beta");
  eq(releaseFeatureUiGroup("marketing"), "beta", "Beta registry → beta");
});

test("describeReleaseFeaturesForSalon: groups partition every key exactly once", () => {
  const groups = describeReleaseFeaturesForSalon({});
  const total =
    groups.base.length + groups.beta.length + groups.plan_column.length;
  eq(total, RELEASE_FEATURE_KEYS.length, "every key grouped exactly once");
  // plan_column = ai_voice (column) + reviews + photos (plan)
  eq(groups.plan_column.length, 3, "plan_column has the 3 external-store keys");
  // Base is every base-phase key NOT in plan_column (none of the 10 base keys
  // are plan/column-sourced today).
  eq(groups.base.length, 10, "all 10 Base keys");
  eq(groups.beta.length, RELEASE_FEATURE_KEYS.length - 13, "remaining Beta keys");
  assert(
    groups.base.every((r) => r.phase === "base"),
    "base group is all base-phase",
  );
  assert(
    groups.plan_column.every(
      (r) => r.source === "plan" || r.source === "column",
    ),
    "plan_column group is all plan/column-sourced",
  );
});

console.log(`\nfeatureRegistry: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

/**
 * Unit tests for the sidebar release-feature visibility rule (PR2).
 *
 * Run: npx tsx src/components/layout/__tests__/sidebarFeatureGating.test.ts
 *
 * The sidebar hides a Beta nav item when its mapped release key is not
 * explicitly true in the server-resolved `releaseFeatures` map. This test
 * pins that rule + the Base-vs-Beta mapping so a future edit can't silently
 * hide a Base item or reveal a Beta one.
 */

import {
  isReleaseFeatureEnabled,
  BETA_FEATURE_KEYS,
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

// Mirror the sidebar gate: `releaseFeatures[key] !== true` → hidden.
type Map = Partial<Record<ReleaseFeatureKey, boolean>>;
const hiddenByGate = (m: Map, key: ReleaseFeatureKey) => m[key] !== true;

// Build the map the layout produces: only Beta keys, resolved from a salon.
function buildReleaseMap(salon: {
  subscription_plan?: string | null;
  plan_override?: string | null;
  feature_flags?: unknown;
  voice_ai_enabled?: boolean | null;
}): Map {
  const m: Map = {};
  for (const k of BETA_FEATURE_KEYS) m[k] = isReleaseFeatureEnabled(salon, k);
  return m;
}

// Sidebar nav items that are release-gated and their mapped keys.
const GATED_NAV: { item: string; key: ReleaseFeatureKey }[] = [
  { item: "reports", key: "advanced_reports" },
  { item: "reviews", key: "reviews" },
  { item: "loyalty", key: "loyalty" },
  { item: "photos", key: "photos" },
  { item: "combos", key: "combos" },
  { item: "marketing", key: "marketing" },
];

// Base nav items that must never be gated by this map.
const BASE_NAV = ["front-desk", "queue", "calendar", "clients", "staff", "services", "settings"];

test("empty salon (no flags): all gated beta nav items are hidden", () => {
  const m = buildReleaseMap({});
  for (const { item, key } of GATED_NAV) {
    // reviews/photos are plan-sourced; with no plan they resolve OFF too.
    eq(hiddenByGate(m, key), true, `${item} should be hidden for empty salon`);
  }
});

test("group_booking flag ON reveals group surface; others stay hidden", () => {
  const m = buildReleaseMap({ feature_flags: { group_booking_enabled: true } });
  eq(m.group_booking, true, "group_booking enabled");
  eq(hiddenByGate(m, "loyalty"), true, "loyalty still hidden");
  eq(hiddenByGate(m, "combos"), true, "combos still hidden");
});

test("loyalty + reports flags ON reveal those nav items", () => {
  const m = buildReleaseMap({
    feature_flags: { loyalty_enabled: true, reports_enabled: true },
  });
  eq(hiddenByGate(m, "loyalty"), false, "loyalty visible when flag on");
  eq(hiddenByGate(m, "advanced_reports"), false, "reports visible when flag on");
});

test("photos/reviews keep plan behavior: pro plan reveals them", () => {
  const m = buildReleaseMap({ subscription_plan: "pro", feature_flags: {} });
  eq(hiddenByGate(m, "photos"), false, "photos visible on pro");
  eq(hiddenByGate(m, "reviews"), false, "reviews visible on pro");
  const free = buildReleaseMap({ subscription_plan: "free", feature_flags: {} });
  eq(hiddenByGate(free, "photos"), true, "photos hidden on free");
  eq(hiddenByGate(free, "reviews"), true, "reviews hidden on free");
});

test("Base nav keys are not present in the gating map (never gated)", () => {
  const m = buildReleaseMap({});
  for (const base of BASE_NAV) {
    eq((m as Record<string, unknown>)[base], undefined, `${base} must not be in release map`);
  }
});

console.log(`\nsidebarFeatureGating: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

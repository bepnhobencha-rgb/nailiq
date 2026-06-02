/**
 * Unit tests for the mobile bottom-nav release-feature visibility rule (PR2).
 *
 * Run: npx tsx src/components/layout/__tests__/mobileNavFeatureGating.test.ts
 *
 * `MobileBottomNav` mirrors `DashboardSidebar`: a Beta tab is hidden when its
 * mapped release key is not explicitly true in the server-resolved
 * `releaseFeatures` map. The mobile rail has only ONE release-gated tab —
 * `reports` (→ `advanced_reports`, jsonb `reports_enabled`, Beta default OFF) —
 * so this test pins that the Reports tab hides when the flag is off and shows
 * when SuperAdmin enables it, while the four fixed Base tabs stay put. Keeps
 * desktop + mobile gating in lockstep (see sidebarFeatureGating.test.ts).
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

// Mirror the mobile-nav gate: `releaseFeatures[key] !== true` → hidden.
// Identical rule to DashboardSidebar's `featureOff`.
type Map = Partial<Record<ReleaseFeatureKey, boolean>>;
const hiddenByGate = (m: Map, key: ReleaseFeatureKey) => m[key] !== true;

// Build the same Beta-only release map the dashboard layout resolves and
// threads into MobileBottomNav via the `releaseFeatures` prop.
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

// The mobile bottom-nav's 5 fixed tabs. Only `reports` is release-gated; the
// other four are Base and must never be hidden by this map.
const REPORTS_KEY: ReleaseFeatureKey = "advanced_reports";
const BASE_MOBILE_TABS = ["front-desk", "queue", "clients", "settings"];

test("reports tab is hidden when advanced_reports is not enabled (empty salon)", () => {
  const m = buildReleaseMap({});
  eq(hiddenByGate(m, REPORTS_KEY), true, "reports hidden for empty salon");
});

test("reports tab is hidden when feature_flags omits reports_enabled", () => {
  // Another Beta flag on must not leak the Reports tab open.
  const m = buildReleaseMap({ feature_flags: { loyalty_enabled: true } });
  eq(hiddenByGate(m, REPORTS_KEY), true, "reports still hidden");
});

test("reports tab is shown when reports_enabled flag is ON", () => {
  const m = buildReleaseMap({ feature_flags: { reports_enabled: true } });
  eq(hiddenByGate(m, REPORTS_KEY), false, "reports visible when flag on");
});

test("reports tab respects an explicit false override", () => {
  const m = buildReleaseMap({ feature_flags: { reports_enabled: false } });
  eq(hiddenByGate(m, REPORTS_KEY), true, "explicit false → hidden");
});

test("Base mobile tabs are never present in the gating map (never gated)", () => {
  const m = buildReleaseMap({ feature_flags: { reports_enabled: true } });
  for (const base of BASE_MOBILE_TABS) {
    eq(
      (m as Record<string, unknown>)[base],
      undefined,
      `${base} must not be in release map`,
    );
  }
});

console.log(`\nmobileNavFeatureGating: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

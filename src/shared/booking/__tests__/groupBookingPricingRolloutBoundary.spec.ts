import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const migrations = readdirSync(resolve(root, "supabase/migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => read(`supabase/migrations/${name}`))
  .join("\n");

describe("public group booking authoritative-pricing rollout boundary", () => {
  it("locks one organizer evidence row per salon and request key", () => {
    const migration = read(
      "supabase/migrations/20260820105820_authorize_group_booking_pricing.sql",
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_group_idempotency_once\s+ON public\.bookings \(salon_id, idempotency_key\)\s+WHERE idempotency_key IS NOT NULL\s+AND group_id IS NOT NULL\s+AND is_group_organizer IS TRUE;/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.quote_group_booking\([\s\S]*?FROM PUBLIC, anon, authenticated;[\s\S]*?GRANT EXECUTE ON FUNCTION public\.quote_group_booking\([\s\S]*?TO service_role;/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.create_group_bookings\([\s\S]*?FROM PUBLIC, anon, authenticated;[\s\S]*?GRANT EXECUTE ON FUNCTION public\.create_group_bookings\([\s\S]*?TO service_role;/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.insert_group_bookings\(jsonb\)\s+FROM PUBLIC, anon, authenticated;\s+GRANT EXECUTE ON FUNCTION public\.insert_group_bookings\(jsonb\)\s+TO service_role;/i,
    );
  });

  it("blocks the legacy-grant cutover while any active salon still exposes Group", () => {
    const migration = read(
      "supabase/migrations/20260820105820_authorize_group_booking_pricing.sql",
    );
    const preflight = read(
      "scripts/security/preflight-public-group-booking-pricing-rollout.sql",
    );
    const activeFlag =
      /s\.archived_at IS NULL[\s\S]*?s\.feature_flags -> 'group_booking_enabled' = 'true'::jsonb/i;

    expect(migration).toMatch(activeFlag);
    expect(migration).toMatch(
      /IF v_enabled_count > 0 THEN[\s\S]*?RAISE EXCEPTION[\s\S]*?group pricing rollout blocked/i,
    );
    expect(preflight).toMatch(activeFlag);
    expect(preflight).toContain("m.enabled_group_salons = 0");
    expect(preflight).toContain("SELECT 1 / 0 AS rollout_preflight_blocked");
  });

  it("keeps the beta fail-safe until the complete group quote/create stack exists", () => {
    const parserPath = "src/shared/booking/groupBookingPricing.ts";
    const quoteServerPath = "src/shared/booking/groupBookingPricingServer.ts";
    const quoteRoutePath = "src/app/api/booking/group-quote/route.ts";
    const createRoutePath = "src/app/api/booking/group-create/route.ts";
    const hasCanonicalGroupRpc =
      /quote_group_booking\s*\(/i.test(migrations) &&
      /create_group_bookings\s*\(/i.test(migrations);
    const runtimePaths = [
      parserPath,
      quoteServerPath,
      quoteRoutePath,
      createRoutePath,
    ];
    const presentRuntimePaths = runtimePaths.filter((path) =>
      existsSync(resolve(root, path)),
    );

    if (!hasCanonicalGroupRpc && presentRuntimePaths.length === 0) {
      const registry = read("src/shared/features/featureRegistry.ts");
      const groupFeature = registry.slice(
        registry.indexOf("group_booking: {"),
        registry.indexOf("ai_voice: {"),
      );
      expect(groupFeature).toContain("phase: \"beta\"");
      expect(groupFeature).toContain("defaultOn: false");
      return;
    }

    // A partially wired pricing path would expose two conflicting sources of
    // truth. Once any canonical group contract appears, the whole boundary is
    // mandatory in the same rollout.
    expect(hasCanonicalGroupRpc).toBe(true);
    expect(presentRuntimePaths).toEqual(runtimePaths);
  });

  it("keeps public and normal desk groups canonical while isolating controlled after-hours legacy", () => {
    if (
      !/quote_group_booking\s*\(/i.test(migrations) ||
      !/create_group_bookings\s*\(/i.test(migrations)
    ) return;

    const submit = read("src/shared/booking/submitGroupBooking.ts");
    const flow = read("src/components/booking/BookingGroupFlow.tsx");
    const receptionist = read("src/shared/dashboard/receptionistActions.ts");

    expect(submit).not.toContain('rpc("insert_group_bookings"');
    expect(submit).not.toContain("/api/vouchers/redeem");
    expect(flow).not.toContain("/api/vouchers/validate");
    expect(submit).toContain("group-create");
    expect(flow).toContain("group-quote");
    const compatibilityStart = submit.indexOf(
      "Phase-A compatibility only for the separately authorized controlled",
    );
    const controlledAddonWrite = submit.indexOf('rpc("add_booking_addons"');
    expect(compatibilityStart).toBeGreaterThan(-1);
    expect(controlledAddonWrite).toBeGreaterThan(compatibilityStart);
    expect(
      submit.slice(compatibilityStart, controlledAddonWrite),
    ).toContain("if (controlledAfterHoursExecution)");
    expect(receptionist).toContain('kind: "canonical_desk"');
    expect(receptionist).toContain("resolveGroupBookingQuote(request)");
    expect(receptionist).toContain("createGroupBookingsAuthoritative");
    expect(receptionist).toContain('kind: "controlled_after_hours"');
  });

  it("keeps Voice Group on two-stage canonical pricing with no legacy writer", () => {
    const voice = read("src/shared/voiceai/toolExecutor.ts");
    const tools = read("src/shared/voiceai/realtimeTools.ts");

    expect(voice).not.toContain('.rpc("insert_group_bookings"');
    expect(voice).toContain("resolveGroupBookingQuote({");
    expect(voice).toContain("createGroupBookingsAuthoritative({");
    expect(voice).toContain("isClearVoicePricingConfirmation(trustedUserUtterance)");
    expect(voice).toContain("expectedPricingFingerprint: confirmedPricingFingerprint");
    expect(tools).toContain("confirmed_pricing_fingerprint");
  });

  it("renders confirm and done from the authoritative quote/create receipts", () => {
    const submit = read("src/shared/booking/submitGroupBooking.ts");
    const flow = read("src/components/booking/BookingGroupFlow.tsx");

    expect(submit).toContain("expectedPricingQuote?: GroupBookingPricingQuote");
    expect(submit).toContain("expectedPricingFingerprint");
    expect(submit).toContain("pricing: authoritativePricing");
    expect(flow).toContain(
      "formatCurrency(pricingQuote.totalCents, pricingQuote.currency)",
    );
    expect(flow).toContain("pricing: res.pricing");
    expect(flow).toContain("successResult.pricing.memberQuotes.map");
    expect(flow).toContain("successResult.pricing.discountLines.map");
    expect(flow).toContain("successResult.pricing.taxBreakdown.map");
    expect(flow).toContain("successResult.pricing.totalCents");
  });
});

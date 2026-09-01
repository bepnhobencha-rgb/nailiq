import { describe, expect, it } from "vitest";
import {
  deriveSetupCoverageManifest,
  SETUP_CAPABILITY_IDS,
  SETUP_CAPABILITY_DEFINITIONS,
  type SetupCapabilityEvidence,
} from "@/shared/dashboard/setupCoverageManifest";

function evidence(
  overrides: Partial<SetupCapabilityEvidence> & {
    id: SetupCapabilityEvidence["id"];
  },
): SetupCapabilityEvidence {
  return {
    state: "configured_on",
    detailEn: `${overrides.id} configured`,
    detailVi: `${overrides.id} đã cấu hình`,
    ...overrides,
  };
}

describe("deriveSetupCoverageManifest", () => {
  it("keeps the canonical capability id list and definitions in exact parity", () => {
    expect(
      SETUP_CAPABILITY_DEFINITIONS.map((definition) => definition.id),
    ).toEqual(SETUP_CAPABILITY_IDS);
    expect(new Set(SETUP_CAPABILITY_IDS).size).toBe(
      SETUP_CAPABILITY_IDS.length,
    );
  });

  it("lists every capability and turns missing evidence into not configured", () => {
    const result = deriveSetupCoverageManifest([]);

    expect(result.totalCount).toBe(SETUP_CAPABILITY_DEFINITIONS.length);
    expect(result.resolvedCount).toBe(0);
    expect(result.percent).toBe(0);
    expect(result.complete).toBe(false);
    expect(result.notConfiguredCount).toBe(result.totalCount);
    expect(result.nextCapability?.id).toBe("salon_profile");
    expect(result.items.every((item) => item.state === "not_configured")).toBe(
      true,
    );
  });

  it("uses canonical order instead of conversation answer order when resuming", () => {
    const result = deriveSetupCoverageManifest([
      evidence({ id: "service_catalog" }),
      evidence({ id: "salon_profile" }),
    ]);

    expect(result.resolvedCount).toBe(2);
    expect(result.nextCapability?.id).toBe("business_hours");
    expect(result.items.slice(0, 4).map((item) => item.id)).toEqual([
      "salon_profile",
      "business_hours",
      "staff_access",
      "service_catalog",
    ]);
  });

  it("treats configured-off and not-using as explicit optional decisions", () => {
    const result = deriveSetupCoverageManifest([
      evidence({ id: "resource_capacity", state: "configured_off" }),
      evidence({ id: "payments_checkout", state: "not_using" }),
    ]);

    expect(
      result.items.find((item) => item.id === "resource_capacity"),
    ).toMatchObject({ resolved: true, state: "configured_off" });
    expect(
      result.items.find((item) => item.id === "payments_checkout"),
    ).toMatchObject({ resolved: true, state: "not_using" });
    expect(result.configuredOffCount).toBe(1);
    expect(result.notUsingCount).toBe(1);
    expect(result.configuredOnCount).toBe(0);
  });

  it("does not let required capabilities resolve as disabled or declined", () => {
    const result = deriveSetupCoverageManifest([
      evidence({ id: "salon_profile", state: "configured_off" }),
      evidence({ id: "booking_policies", state: "not_using" }),
    ]);

    expect(
      result.items.find((item) => item.id === "salon_profile"),
    ).toMatchObject({ resolved: false });
    expect(
      result.items.find((item) => item.id === "booking_policies"),
    ).toMatchObject({ resolved: false });
    expect(result.nextCapability?.id).toBe("salon_profile");
  });

  it("keeps blocked and approval-required capabilities unresolved", () => {
    const result = deriveSetupCoverageManifest([
      evidence({
        id: "payments_checkout",
        state: "blocked",
        detailEn: "Provider credentials are not verified.",
      }),
      evidence({
        id: "safe_preview_go_live",
        state: "needs_approval",
        detailEn: "Owner approval is required.",
      }),
    ]);

    expect(result.blockedCount).toBe(1);
    expect(result.needsApprovalCount).toBe(1);
    expect(
      result.items.find((item) => item.id === "payments_checkout"),
    ).toMatchObject({
      resolved: false,
      detailEn: "Provider credentials are not verified.",
    });
    expect(
      result.items.find((item) => item.id === "safe_preview_go_live"),
    ).toMatchObject({ resolved: false });
  });

  it("requires an approved final state for safe preview and Go-Live", () => {
    const result = deriveSetupCoverageManifest([
      evidence({ id: "safe_preview_go_live", state: "configured_off" }),
    ]);

    expect(
      result.items.find((item) => item.id === "safe_preview_go_live"),
    ).toMatchObject({ resolved: false });
  });

  it("reports complete only when every required setup or decision is resolved", () => {
    const allResolved = SETUP_CAPABILITY_DEFINITIONS.map((definition) =>
      evidence({
        id: definition.id,
        state:
          definition.requirement === "explicit_decision"
            ? "configured_off"
            : "configured_on",
      }),
    );

    const result = deriveSetupCoverageManifest(allResolved);

    expect(result).toMatchObject({
      resolvedCount: SETUP_CAPABILITY_DEFINITIONS.length,
      percent: 100,
      complete: true,
      nextCapability: null,
    });
    expect(result.configuredOnCount).toBe(6);
    expect(result.configuredOffCount).toBe(9);
  });

  it("rejects duplicate evidence instead of silently choosing an answer", () => {
    expect(() =>
      deriveSetupCoverageManifest([
        evidence({ id: "salon_profile" }),
        evidence({ id: "salon_profile", state: "configured_off" }),
      ]),
    ).toThrow("Duplicate setup capability evidence: salon_profile");
  });
});

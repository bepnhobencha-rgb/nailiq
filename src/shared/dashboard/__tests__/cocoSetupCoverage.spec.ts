import { describe, expect, it } from "vitest";
import { deriveCocoSetupCoverage } from "@/shared/dashboard/cocoSetupCoverage";
import type {
  GoLiveReadiness,
  GoLiveReadinessState,
} from "@/shared/dashboard/goLiveReadiness";

const CHECK_IDS = [
  "identity",
  "schedule",
  "staff",
  "catalog",
  "booking-policy",
  "fallback-channel",
  "notification-language",
  "otp-policy",
  "human-approval",
  "owner-approval",
  "multi_service_sequence",
] as const;

function readiness(
  state: GoLiveReadinessState = "action",
  overrides: Partial<Record<(typeof CHECK_IDS)[number], GoLiveReadinessState>> = {},
): GoLiveReadiness {
  return {
    checks: CHECK_IDS.map((id) => ({
      id,
      state: overrides[id] ?? state,
      blocking: true,
      titleEn: id,
      titleVi: id,
      detailEn: `${id} en`,
      detailVi: `${id} vi`,
    })),
    passedBlocking: 0,
    totalBlocking: CHECK_IDS.length,
    readyForManualReview: false,
    approvedForGoLive: false,
  };
}

describe("deriveCocoSetupCoverage", () => {
  it("projects every canonical capability from runtime evidence", () => {
    const result = deriveCocoSetupCoverage({
      readiness: readiness("pass"),
      featureFlags: {
        group_booking_enabled: true,
        multi_service_booking_enabled: true,
        walkin_queue_enabled: true,
        reports_enabled: true,
      },
      resourcesEnabled: true,
      phoneOtpEnabled: true,
      paymentProvider: null,
      voiceAiEnabled: false,
      optionalIntegrationsSkipped: false,
    });

    expect(result.totalCount).toBe(15);
    expect(result.items.find((item) => item.id === "resource_capacity")).toMatchObject({
      state: "configured_on",
      resolved: true,
    });
    expect(result.items.find((item) => item.id === "multi_service")).toMatchObject({
      state: "configured_on",
      resolved: true,
    });
    expect(result.items.find((item) => item.id === "payments_checkout")).toMatchObject({
      state: "not_configured",
      resolved: false,
    });
  });

  it("honors a saved safe skip decision without pretending a provider works", () => {
    const result = deriveCocoSetupCoverage({
      readiness: readiness("pass"),
      featureFlags: {
        coco_setup_decisions: {
          payments_checkout: "not_using",
          ai_automation: "configured_off",
        },
      },
      resourcesEnabled: false,
      phoneOtpEnabled: false,
      paymentProvider: null,
      voiceAiEnabled: false,
      optionalIntegrationsSkipped: false,
    });

    expect(result.items.find((item) => item.id === "payments_checkout")).toMatchObject({
      state: "not_using",
      resolved: true,
    });
    expect(result.items.find((item) => item.id === "ai_automation")).toMatchObject({
      state: "configured_off",
      resolved: true,
    });
  });

  it("keeps selected but unverified payments and AI behind approval", () => {
    const result = deriveCocoSetupCoverage({
      readiness: readiness("pass"),
      featureFlags: { ai_text_receptionist_enabled: true },
      resourcesEnabled: false,
      phoneOtpEnabled: false,
      paymentProvider: "stripe",
      voiceAiEnabled: false,
      optionalIntegrationsSkipped: false,
    });

    expect(result.items.find((item) => item.id === "payments_checkout")).toMatchObject({
      state: "needs_approval",
      resolved: false,
    });
    expect(result.items.find((item) => item.id === "ai_automation")).toMatchObject({
      state: "needs_approval",
      resolved: false,
    });
  });

  it("blocks an enabled multi-service policy without readiness proof", () => {
    const result = deriveCocoSetupCoverage({
      readiness: readiness("pass", { multi_service_sequence: "action" }),
      featureFlags: { multi_service_booking_enabled: true },
      resourcesEnabled: false,
      phoneOtpEnabled: false,
      paymentProvider: null,
      voiceAiEnabled: false,
      optionalIntegrationsSkipped: false,
    });

    expect(result.items.find((item) => item.id === "multi_service")).toMatchObject({
      state: "blocked",
      resolved: false,
    });
  });
});

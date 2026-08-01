import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENING_HOURS_JSON,
  parseOpeningHours,
  stableOpeningHoursJson,
} from "@/shared/dashboard/openingHoursDefaults";
import { evaluateGoLiveReadiness } from "@/shared/dashboard/goLiveReadiness";

const readyInput = {
  slug: "tech-nails",
  name: "Tech Nails",
  address: "123 Main Street",
  salonPhone: "+16045550123",
  timezone: "America/Vancouver",
  openingHours: (() => {
    const hours = parseOpeningHours(DEFAULT_OPENING_HOURS_JSON)!;
    hours.mon.close = "19:00";
    return JSON.parse(stableOpeningHoursJson(hours));
  })(),
  profileComplete: true,
  email: "hello@example.com",
  emailVerified: true,
  emailLinksEnabled: true,
  phoneOtpEnabled: true,
  activeServices: [{ priceCents: 4500, durationMinutes: 45 }],
  activeStaffCount: 2,
};

describe("evaluateGoLiveReadiness", () => {
  it("separates technical gates from mandatory human approval", () => {
    const result = evaluateGoLiveReadiness(readyInput);

    expect(result.readyForManualReview).toBe(true);
    expect(result.passedBlocking).toBe(result.totalBlocking);
    expect(result.approvedForGoLive).toBe(false);
    expect(
      result.checks.find((check) => check.id === "human-approval"),
    ).toMatchObject({ state: "review", blocking: false });
  });

  it("requires all human attestations before reporting go-live approval", () => {
    const result = evaluateGoLiveReadiness({
      ...readyInput,
      humanAttestations: {
        hoursConfirmed: true,
        otpPolicyConfirmed: true,
        liveRehearsalCompleted: true,
        ownerApproved: true,
        ownerApprovalStale: false,
      },
    });

    expect(result.approvedForGoLive).toBe(true);
    expect(
      result.checks
        .filter((check) =>
          [
            "hours-confirmation",
            "otp-policy",
            "human-approval",
            "owner-approval",
          ].includes(check.id),
        )
        .every((check) => check.state === "pass"),
    ).toBe(true);
  });

  it("fails closed when bookable data is incomplete", () => {
    const result = evaluateGoLiveReadiness({
      ...readyInput,
      salonPhone: " ",
      activeServices: [{ priceCents: 2000, durationMinutes: 0 }],
      activeStaffCount: 0,
      profileComplete: false,
    });

    expect(result.readyForManualReview).toBe(false);
    expect(
      result.checks
        .filter((check) => check.blocking && check.state === "action")
        .map((check) => check.id),
    ).toEqual(
      expect.arrayContaining(["identity", "catalog", "staff", "public-booking"]),
    );
  });

  it("requires review when default hours or communication fallback remain", () => {
    const result = evaluateGoLiveReadiness({
      ...readyInput,
      openingHours: JSON.parse(DEFAULT_OPENING_HOURS_JSON),
      email: null,
      emailVerified: false,
      emailLinksEnabled: false,
      phoneOtpEnabled: false,
    });

    expect(result.readyForManualReview).toBe(true);
    expect(result.checks.find((check) => check.id === "schedule")).toMatchObject(
      { state: "pass", blocking: true },
    );
    expect(
      result.checks.find((check) => check.id === "hours-confirmation"),
    ).toMatchObject({ state: "review", blocking: false });
    expect(
      result.checks.find((check) => check.id === "fallback-channel"),
    ).toMatchObject({ state: "review", blocking: false });
    expect(
      result.checks.find((check) => check.id === "otp-policy"),
    ).toMatchObject({ state: "review", blocking: false });
  });

  it("blocks unsupported timezone or a fully closed schedule", () => {
    const hours = parseOpeningHours(DEFAULT_OPENING_HOURS_JSON)!;
    for (const day of Object.values(hours)) day.closed = true;

    const result = evaluateGoLiveReadiness({
      ...readyInput,
      timezone: "Mars/Olympus",
      openingHours: hours,
    });

    expect(result.readyForManualReview).toBe(false);
    expect(result.checks.find((check) => check.id === "schedule")).toMatchObject(
      { state: "action", blocking: true },
    );
  });
});

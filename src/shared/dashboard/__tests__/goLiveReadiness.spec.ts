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
  cancellationPolicy: {
    en: "Cancel at least 24 hours before your appointment.",
    vi: "Huỷ trước lịch hẹn ít nhất 24 giờ.",
  },
  defaultNotificationLocale: "en",
  paymentProvider: null,
  voiceAiEnabled: false,
  staffAccessValid: true,
  serviceCoverageValid: true,
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
    expect(result.checks.find((check) => check.id === "identity")).toMatchObject({
      state: "pass",
      blocking: true,
    });
    expect(result.checks.find((check) => check.id === "schedule")).toMatchObject({
      state: "action",
      blocking: true,
    });
  });

  it("rejects malformed stored salon phone values", () => {
    const result = evaluateGoLiveReadiness({
      ...readyInput,
      guidedSetupEnabled: true,
      salonPhone: "not-a-phone",
    });

    expect(result.checks.find((check) => check.id === "identity")).toMatchObject({
      state: "action",
      blocking: true,
    });
  });

  it("accepts a valid seven-days-open salon and rejects invalid times or dates", () => {
    const sevenDaysOpen = parseOpeningHours(DEFAULT_OPENING_HOURS_JSON)!;
    for (const day of Object.values(sevenDaysOpen)) day.closed = false;

    expect(
      evaluateGoLiveReadiness({
        ...readyInput,
        guidedSetupEnabled: true,
        openingHours: sevenDaysOpen,
        bookingClosedDates: [],
      }).checks.find((check) => check.id === "schedule"),
    ).toMatchObject({ state: "pass" });

    sevenDaysOpen.mon.open = "18:00";
    sevenDaysOpen.mon.close = "09:00";
    expect(
      evaluateGoLiveReadiness({
        ...readyInput,
        guidedSetupEnabled: true,
        openingHours: sevenDaysOpen,
      }).checks.find((check) => check.id === "schedule"),
    ).toMatchObject({ state: "action" });

    expect(
      evaluateGoLiveReadiness({
        ...readyInput,
        guidedSetupEnabled: true,
        bookingClosedDates: ["2026-02-30"],
      }).checks.find((check) => check.id === "schedule"),
    ).toMatchObject({ state: "action" });
  });

  it("preserves pre-pilot phone and schedule semantics when the flag is off", () => {
    const legacyHours = parseOpeningHours(DEFAULT_OPENING_HOURS_JSON)!;
    legacyHours.mon.open = "18:00";
    legacyHours.mon.close = "09:00";

    const result = evaluateGoLiveReadiness({
      ...readyInput,
      salonPhone: "legacy-phone-value",
      openingHours: legacyHours,
      bookingClosedDates: ["2026-02-30"],
    });

    expect(result.checks.find((check) => check.id === "identity")).toMatchObject({
      state: "pass",
      blocking: true,
    });
    expect(result.checks.find((check) => check.id === "schedule")).toMatchObject({
      state: "pass",
      blocking: true,
    });
  });

  it("preserves the exact pre-pilot check output when the flag is off", () => {
    const result = evaluateGoLiveReadiness(readyInput);

    expect(
      result.checks.map(({ id, state, blocking }) => ({ id, state, blocking })),
    ).toEqual([
      { id: "identity", state: "pass", blocking: true },
      { id: "catalog", state: "pass", blocking: true },
      { id: "staff", state: "pass", blocking: true },
      { id: "schedule", state: "pass", blocking: true },
      { id: "public-booking", state: "pass", blocking: true },
      { id: "fallback-channel", state: "pass", blocking: false },
      { id: "hours-confirmation", state: "review", blocking: false },
      { id: "otp-policy", state: "review", blocking: false },
      { id: "human-approval", state: "review", blocking: false },
      { id: "owner-approval", state: "review", blocking: false },
    ]);
    expect(result).toMatchObject({
      passedBlocking: 5,
      totalBlocking: 5,
      readyForManualReview: true,
      approvedForGoLive: false,
    });
  });

  it("makes every Guided Setup data requirement block QA-pilot approval", () => {
    const missing = evaluateGoLiveReadiness({
      ...readyInput,
      guidedSetupEnabled: true,
      cancellationPolicy: null,
      email: null,
      emailVerified: false,
      emailLinksEnabled: false,
      defaultNotificationLocale: "fr",
      humanAttestations: {
        hoursConfirmed: true,
        otpPolicyConfirmed: true,
        liveRehearsalCompleted: true,
        ownerApproved: true,
        ownerApprovalStale: false,
      },
    });

    expect(missing.readyForManualReview).toBe(false);
    expect(missing.approvedForGoLive).toBe(false);
    expect(
      missing.checks
        .filter((check) => check.blocking && check.state !== "pass")
        .map((check) => check.id),
    ).toEqual(
      expect.arrayContaining([
        "booking-policy",
        "fallback-channel",
        "notification-language",
      ]),
    );

    const complete = evaluateGoLiveReadiness({
      ...readyInput,
      guidedSetupEnabled: true,
      humanAttestations: {
        hoursConfirmed: true,
        otpPolicyConfirmed: true,
        liveRehearsalCompleted: true,
        ownerApproved: true,
        ownerApprovalStale: false,
      },
    });

    expect(complete.totalBlocking).toBe(8);
    expect(complete.passedBlocking).toBe(8);
    expect(complete.readyForManualReview).toBe(true);
    expect(complete.approvedForGoLive).toBe(false);
  });

  it("fails the Guided Setup pilot closed on access, capability, and group-rule gaps", () => {
    const result = evaluateGoLiveReadiness({
      ...readyInput,
      guidedSetupEnabled: true,
      staffAccessValid: false,
      serviceCoverageValid: false,
      groupBookingEnabled: true,
      groupTogetherThresholdMinutes: 121,
      noShowGroupWholeParty: null,
    });

    expect(result.approvedForGoLive).toBe(false);
    expect(result.checks.find((check) => check.id === "staff")).toMatchObject({
      state: "action",
      blocking: true,
    });
    expect(result.checks.find((check) => check.id === "catalog")).toMatchObject({
      state: "action",
      blocking: true,
    });
    expect(
      result.checks.find((check) => check.id === "booking-policy"),
    ).toMatchObject({ state: "action", blocking: true });
  });

  it("requires an explicit numeric group threshold when group booking is enabled", () => {
    const result = evaluateGoLiveReadiness({
      ...readyInput,
      guidedSetupEnabled: true,
      groupBookingEnabled: true,
      groupTogetherThresholdMinutes: null,
      noShowGroupWholeParty: false,
    });

    expect(
      result.checks.find((check) => check.id === "booking-policy"),
    ).toMatchObject({ state: "action", blocking: true });
  });

  it("never approves the QA pilot from a rehearsal attestation without safe preview proof", () => {
    const result = evaluateGoLiveReadiness({
      ...readyInput,
      guidedSetupEnabled: true,
      humanAttestations: {
        hoursConfirmed: true,
        otpPolicyConfirmed: true,
        liveRehearsalCompleted: true,
        ownerApproved: true,
        ownerApprovalStale: false,
      },
    });

    expect(result.approvedForGoLive).toBe(false);
    expect(
      result.checks.find((check) => check.id === "human-approval"),
    ).toMatchObject({ state: "review" });
  });

  it("does not treat selecting an optional provider as runtime proof", () => {
    const result = evaluateGoLiveReadiness({
      ...readyInput,
      guidedSetupEnabled: true,
      paymentProvider: "stripe",
    });

    expect(
      result.checks.find((check) => check.id === "optional-integrations"),
    ).toMatchObject({ state: "review", blocking: false, selected: true });
  });
});

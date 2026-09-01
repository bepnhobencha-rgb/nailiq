import { describe, expect, it } from "vitest";

import {
  emptyWaitlistDeliveryTruth,
  summarizeWaitlistDeliveryTruth,
  type WaitlistDeliveryTruthRow,
} from "../waitlistDeliveryTruth";

const ENTRY = "11111111-1111-4111-8111-111111111111";

function row(
  override: Partial<WaitlistDeliveryTruthRow>,
): WaitlistDeliveryTruthRow {
  return {
    waitlist_entry_id: ENTRY,
    offer_epoch: 2,
    channel: "sms",
    status: "sent",
    error_code: null,
    updated_at: "2026-08-31T23:00:00.000Z",
    ...override,
  };
}

describe("waitlist delivery truth", () => {
  it("reports each current-epoch channel without exposing provider material", () => {
    const truth = summarizeWaitlistDeliveryTruth(
      new Map([[ENTRY, 2]]),
      [
        row({ channel: "sms", status: "sent" }),
        row({
          channel: "email",
          status: "suppressed",
          error_code: "channel_disabled",
        }),
      ],
    ).get(ENTRY);

    expect(truth).toEqual({
      offerEpoch: 2,
      sms: {
        status: "sent",
        reason: null,
        updatedAt: "2026-08-31T23:00:00.000Z",
      },
      email: {
        status: "suppressed",
        reason: "channel_disabled",
        updatedAt: "2026-08-31T23:00:00.000Z",
      },
    });
  });

  it("ignores stale epochs so an old failure cannot repaint a new offer", () => {
    const truth = summarizeWaitlistDeliveryTruth(
      new Map([[ENTRY, 3]]),
      [
        row({ offer_epoch: 2, status: "failed", error_code: "provider_rejected" }),
        row({ offer_epoch: 3, status: "sending", error_code: null }),
      ],
    ).get(ENTRY);

    expect(truth?.sms).toMatchObject({ status: "sending", reason: null });
    expect(truth?.email).toEqual(emptyWaitlistDeliveryTruth(3).email);
  });

  it("fails closed for malformed statuses and classifies uncertain outcomes", () => {
    const truth = summarizeWaitlistDeliveryTruth(
      new Map([[ENTRY, 2]]),
      [
        row({ status: "delivered_by_magic" }),
        row({
          channel: "email",
          status: "unknown",
          error_code: "invalid_provider_receipt",
        }),
      ],
    ).get(ENTRY);

    expect(truth?.sms.status).toBe("unavailable");
    expect(truth?.email).toMatchObject({
      status: "unknown",
      reason: "outcome_unknown",
    });
  });

  it.each([
    ["recipient_missing", "recipient_missing"],
    ["provider_stop", "recipient_suppressed"],
    ["email_opt_out", "recipient_suppressed"],
  ] as const)("maps %s to a safe receptionist reason", (errorCode, reason) => {
    const truth = summarizeWaitlistDeliveryTruth(
      new Map([[ENTRY, 2]]),
      [row({ status: "suppressed", error_code: errorCode })],
    ).get(ENTRY);
    expect(truth?.sms.reason).toBe(reason);
  });
});

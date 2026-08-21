import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  deliverClaimedStaffActionNotification,
  serializeStaffActionNotificationEnvelope,
  type StaffActionEmailEnvelope,
  type StaffActionNotificationDeliveryDeps,
  type StaffActionSmsEnvelope,
} from "@/shared/notifications/staffActionNotificationDelivery";

const smsEnvelope: StaffActionSmsEnvelope = {
  v: 1,
  kind: "staff_action",
  channel: "sms",
  salonId: "11111111-1111-4111-8111-111111111111",
  bookingId: "22222222-2222-4222-8222-222222222222",
  event: "cancel",
  actorUserId: "33333333-3333-4333-8333-333333333333",
  actorRole: "receptionist",
  to: "+16045550199",
  body: "Your appointment was cancelled. Reply STOP to opt out.",
  statusCallbackUrl: "https://nailiq.test/api/webhooks/twilio-status",
  salonIsTest: false,
  lang: "en",
};

const emailEnvelope: StaffActionEmailEnvelope = {
  v: 1,
  kind: "staff_action",
  channel: "email",
  salonId: smsEnvelope.salonId,
  bookingId: smsEnvelope.bookingId,
  event: "reschedule",
  actorUserId: smsEnvelope.actorUserId,
  actorRole: smsEnvelope.actorRole,
  to: "mai@example.com",
  from: "NailIQ <notices@example.com>",
  subject: "Your appointment was rescheduled",
  html: "<p>Your appointment was rescheduled.</p>",
  text: "Your appointment was rescheduled.",
  headers: { "List-Unsubscribe": "<https://nailiq.test/unsubscribe>" },
  replyTo: null,
};

describe("staff-action exact SMS replay acceptance", () => {
  it("sends the exact leased SMS envelope once and completes the same token with its valid receipt", async () => {
    const serialized = serializeStaffActionNotificationEnvelope(smsEnvelope);
    expect(serialized).not.toBeNull();

    const sendSms = vi.fn().mockResolvedValue({
      ok: true,
      messageSid: `SM${"a".repeat(32)}`,
    });
    const complete = vi.fn().mockResolvedValue({
      success: true,
      code: "delivery_completed",
    });
    const deps: StaffActionNotificationDeliveryDeps = {
      sendSms,
      sendEmail: vi.fn(),
      complete,
    };

    const result = await deliverClaimedStaffActionNotification({
      success: true,
      code: "delivery_claimed",
      delivery_id: "44444444-4444-4444-8444-444444444444",
      event_id: "55555555-5555-4555-8555-555555555555",
      attempt_token: "66666666-6666-4666-8666-666666666666",
      attempt_count: 1,
      envelope_fingerprint: serialized?.envelopeFingerprint,
      dispatch_envelope: serialized?.envelope,
    }, deps);

    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms).toHaveBeenCalledWith(smsEnvelope);
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({
      deliveryId: "44444444-4444-4444-8444-444444444444",
      attemptToken: "66666666-6666-4666-8666-666666666666",
      status: "sent",
      providerMessageId: `SM${"a".repeat(32)}`,
      errorCode: null,
      failureDisposition: "none",
    });
    expect(result).toEqual({
      deliveryId: "44444444-4444-4444-8444-444444444444",
      outcome: "accepted",
      reason: "provider_accepted",
      providerMessageId: `SM${"a".repeat(32)}`,
      finalized: true,
    });
  });

  it("sends the exact leased email envelope once and completes the same token with its receipt", async () => {
    const serialized = serializeStaffActionNotificationEnvelope(emailEnvelope);
    expect(serialized).not.toBeNull();

    const sendEmail = vi.fn().mockResolvedValue({
      data: { id: "resend-accepted-1" },
      error: null,
    });
    const complete = vi.fn().mockResolvedValue({
      success: true,
      code: "delivery_completed",
    });
    const deps: StaffActionNotificationDeliveryDeps = {
      sendSms: vi.fn(),
      sendEmail,
      complete,
    };

    const result = await deliverClaimedStaffActionNotification({
      success: true,
      code: "delivery_claimed",
      delivery_id: "77777777-7777-4777-8777-777777777777",
      event_id: "88888888-8888-4888-8888-888888888888",
      attempt_token: "99999999-9999-4999-8999-999999999999",
      attempt_count: 1,
      envelope_fingerprint: serialized?.envelopeFingerprint,
      dispatch_envelope: serialized?.envelope,
    }, deps);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(emailEnvelope);
    expect(deps.sendSms).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith({
      deliveryId: "77777777-7777-4777-8777-777777777777",
      attemptToken: "99999999-9999-4999-8999-999999999999",
      status: "sent",
      providerMessageId: "resend-accepted-1",
      errorCode: null,
      failureDisposition: "none",
    });
    expect(result).toMatchObject({
      outcome: "accepted",
      providerMessageId: "resend-accepted-1",
      finalized: true,
    });
  });

  it("records an ambiguous provider exception as terminal unknown, never retryable", async () => {
    const serialized = serializeStaffActionNotificationEnvelope(smsEnvelope);
    const complete = vi.fn().mockResolvedValue({
      success: true,
      code: "delivery_completed",
    });
    const deps: StaffActionNotificationDeliveryDeps = {
      sendSms: vi.fn().mockRejectedValue(new Error("response lost")),
      sendEmail: vi.fn(),
      complete,
    };

    const result = await deliverClaimedStaffActionNotification({
      success: true,
      code: "delivery_claimed",
      delivery_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      event_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      attempt_token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      attempt_count: 1,
      envelope_fingerprint: serialized?.envelopeFingerprint,
      dispatch_envelope: serialized?.envelope,
    }, deps);

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "unknown",
      errorCode: "provider_exception",
      failureDisposition: "none",
    }));
    expect(result).toMatchObject({ outcome: "unknown", finalized: true });
  });
});

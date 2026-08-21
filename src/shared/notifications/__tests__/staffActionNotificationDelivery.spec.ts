import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  deliverClaimedStaffActionNotification,
  serializeStaffActionNotificationEnvelope,
  type StaffActionNotificationDeliveryDeps,
  type StaffActionNotificationEnvelope,
} from "@/shared/notifications/staffActionNotificationDelivery";

const DELIVERY_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_TOKEN = "33333333-3333-4333-8333-333333333333";
const SALON_ID = "44444444-4444-4444-8444-444444444444";
const BOOKING_ID = "55555555-5555-4555-8555-555555555555";
const ACTOR_ID = "66666666-6666-4666-8666-666666666666";

const smsEnvelope: StaffActionNotificationEnvelope = {
  v: 1,
  kind: "staff_action",
  channel: "sms",
  salonId: SALON_ID,
  bookingId: BOOKING_ID,
  event: "cancel",
  actorUserId: ACTOR_ID,
  actorRole: "owner",
  to: "+16045550199",
  body: "Your appointment was cancelled. Reply STOP to opt out.",
  statusCallbackUrl: "https://nailiq.test/api/webhooks/twilio-status",
  salonIsTest: false,
  lang: "en",
};

const emailEnvelope: StaffActionNotificationEnvelope = {
  v: 1,
  kind: "staff_action",
  channel: "email",
  salonId: SALON_ID,
  bookingId: BOOKING_ID,
  event: "reschedule",
  actorUserId: ACTOR_ID,
  actorRole: "receptionist",
  to: "customer@example.com",
  from: "NailIQ <notices@example.com>",
  subject: "Appointment rescheduled",
  html: "<p>Your appointment was rescheduled.</p>",
  text: "Your appointment was rescheduled.",
  headers: { "List-Unsubscribe": "<https://nailiq.test/unsubscribe>" },
  replyTo: null,
};

function lease(envelope: StaffActionNotificationEnvelope) {
  const serialized = serializeStaffActionNotificationEnvelope(envelope);
  if (!serialized) throw new Error("invalid fixture");
  return {
    success: true,
    code: "delivery_claimed",
    delivery_id: DELIVERY_ID,
    event_id: EVENT_ID,
    attempt_token: ATTEMPT_TOKEN,
    attempt_count: 1,
    envelope_fingerprint: serialized.envelopeFingerprint,
    dispatch_envelope: serialized.envelope,
  };
}

function deps(): StaffActionNotificationDeliveryDeps {
  return {
    sendSms: vi.fn().mockResolvedValue({
      ok: true,
      messageSid: `SM${"a".repeat(32)}`,
    }),
    sendEmail: vi.fn().mockResolvedValue({ data: { id: "email_accepted_1" }, error: null }),
    complete: vi.fn().mockResolvedValue({ success: true, code: "delivery_completed" }),
  };
}

describe("durable staff-action notification delivery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fails closed before provider and completion on malformed or changed envelope material", async () => {
    const d = deps();
    const raw = lease(smsEnvelope);
    raw.dispatch_envelope = raw.dispatch_envelope.replace("cancelled", "moved");

    const result = await deliverClaimedStaffActionNotification(raw, d);

    expect(result).toMatchObject({ outcome: "rejected", reason: "invalid_claim", finalized: false });
    expect(d.sendSms).not.toHaveBeenCalled();
    expect(d.sendEmail).not.toHaveBeenCalled();
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("sends the exact immutable email envelope only after a valid claim and records its receipt", async () => {
    const d = deps();
    const result = await deliverClaimedStaffActionNotification(lease(emailEnvelope), d);

    expect(d.sendEmail).toHaveBeenCalledTimes(1);
    expect(d.sendEmail).toHaveBeenCalledWith(emailEnvelope);
    expect(d.sendSms).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith({
      deliveryId: DELIVERY_ID,
      attemptToken: ATTEMPT_TOKEN,
      status: "sent",
      providerMessageId: "email_accepted_1",
      errorCode: null,
      failureDisposition: "none",
    });
    expect(result).toMatchObject({
      outcome: "accepted",
      providerMessageId: "email_accepted_1",
      finalized: true,
    });
  });

  it("classifies a definite pre-acceptance provider outage as the only retryable failure", async () => {
    const d = deps();
    vi.mocked(d.sendSms).mockResolvedValue({ ok: false, error: "twilio_503" });

    const result = await deliverClaimedStaffActionNotification(lease(smsEnvelope), d);

    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      errorCode: "sms_unavailable_pre_acceptance",
      failureDisposition: "retryable_pre_acceptance",
    }));
    expect(result).toMatchObject({ outcome: "rejected", finalized: true });
  });

  it("records a thrown/ambiguous provider outcome as unknown and never labels it retryable", async () => {
    const d = deps();
    vi.mocked(d.sendSms).mockRejectedValue(new Error("response lost"));

    const result = await deliverClaimedStaffActionNotification(lease(smsEnvelope), d);

    expect(d.sendSms).toHaveBeenCalledTimes(1);
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "unknown",
      errorCode: "provider_exception",
      failureDisposition: "none",
    }));
    expect(result).toMatchObject({ outcome: "unknown", finalized: true });
  });

  it("treats missing email provider configuration as permanent before status retry rules", async () => {
    const d = deps();
    vi.mocked(d.sendEmail).mockResolvedValue({
      data: null,
      error: { code: "provider_configuration_invalid", statusCode: 503 },
    });

    const result = await deliverClaimedStaffActionNotification(lease(emailEnvelope), d);

    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      errorCode: "provider_configuration_invalid",
      failureDisposition: "permanent",
    }));
    expect(result).toMatchObject({ outcome: "rejected", finalized: true });
  });

  it("persists consent/provider suppression without dispatching a retry", async () => {
    const d = deps();
    vi.mocked(d.sendSms).mockResolvedValue({
      ok: true,
      suppressed: true,
      suppressionReason: "consent_revoked",
    });

    const result = await deliverClaimedStaffActionNotification(lease(smsEnvelope), d);

    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "suppressed",
      errorCode: "consent_revoked",
      failureDisposition: "permanent",
    }));
    expect(result).toMatchObject({ outcome: "suppressed", finalized: true });
  });

  it("fails closed and permits retry when consent truth is unavailable before provider", async () => {
    const d = deps();
    vi.mocked(d.sendSms).mockResolvedValue({
      ok: false,
      error: "sms_consent_unavailable",
      suppressed: true,
      suppressionReason: "consent_unavailable",
    });

    const result = await deliverClaimedStaffActionNotification(lease(smsEnvelope), d);

    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      errorCode: "consent_unavailable_pre_acceptance",
      failureDisposition: "retryable_pre_acceptance",
    }));
    expect(result).toMatchObject({ outcome: "rejected", finalized: true });
  });
});

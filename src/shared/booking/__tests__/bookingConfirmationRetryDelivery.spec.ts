import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  deliverBookingConfirmation,
  deliverLeasedBookingConfirmationRetry,
  runBookingConfirmationRetryWorker,
  serializeBookingConfirmationEnvelope,
  type BookingConfirmationDispatchEnvelope,
  type BookingConfirmationRetryDeliveryDeps,
} from "@/shared/booking/bookingConfirmationRetryDelivery";

const BOOKING_ID = "11111111-1111-4111-8111-111111111111";
const SALON_ID = "22222222-2222-4222-8222-222222222222";
const CLAIM_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN_1 = "44444444-4444-4444-8444-444444444444";
const TOKEN_2 = "55555555-5555-4555-8555-555555555555";

const sms: BookingConfirmationDispatchEnvelope = {
  v: 1,
  channel: "sms",
  salonId: SALON_ID,
  to: "+16045101234",
  body: "Booked from immutable facts. Reply STOP to opt out.",
  statusCallbackUrl: "https://nailiq.test/api/twilio/status",
  salonIsTest: false,
  lang: "en",
};

const email: BookingConfirmationDispatchEnvelope = {
  v: 1,
  channel: "email",
  salonId: SALON_ID,
  to: "mai@example.test",
  from: "NailIQ <bookings@nailiq.test>",
  subject: "Booking confirmed",
  html: "<html><body>Immutable confirmation</body></html>",
  headers: { "List-Unsubscribe": "<https://nailiq.test/unsubscribe>" },
  replyTo: "salon@example.test",
  attachments: [{
    filename: "appointment.ics",
    content: "QkVHSU46VkNBTEVOREFS",
    contentType: "text/calendar; method=PUBLISH",
  }],
};

function deps(overrides: Partial<BookingConfirmationRetryDeliveryDeps> = {}) {
  const base: BookingConfirmationRetryDeliveryDeps = {
    claim: vi.fn().mockResolvedValue({
      success: true,
      code: "claimed",
      claimed: true,
      claimId: CLAIM_ID,
      attemptToken: TOKEN_1,
      attemptCount: 1,
    }),
    complete: vi.fn().mockResolvedValue({ success: true, code: "completed" }),
    sendSms: vi.fn().mockResolvedValue({ ok: true, messageSid: `SM${"a".repeat(32)}` }),
    sendEmail: vi.fn().mockResolvedValue({ data: { id: "resend_accept_1" }, error: null }),
    emailSuppressionReason: vi.fn().mockResolvedValue(null),
  };
  return { ...base, ...overrides };
}

function lease(envelope: BookingConfirmationDispatchEnvelope) {
  const material = serializeBookingConfirmationEnvelope(envelope)!;
  return {
    success: true,
    code: "leased",
    claim_id: CLAIM_ID,
    attempt_token: TOKEN_2,
    attempt_count: 2,
    salon_id: SALON_ID,
    booking_id: BOOKING_ID,
    channel: envelope.channel,
    payload_fingerprint: material.payloadFingerprint,
    recipient_fingerprint: material.recipientFingerprint,
    dispatch_envelope: material.text,
  };
}

describe("booking confirmation tokenized retry delivery", () => {
  it.each([
    [sms, "sendSms", `SM${"a".repeat(32)}`],
    [email, "sendEmail", "resend_accept_1"],
  ] as const)("claims before the %s provider and completes with its receipt", async (envelope, sender, receipt) => {
    const order: string[] = [];
    const d = deps({
      claim: vi.fn(async () => {
        order.push("claim");
        return { success: true, code: "claimed", claimed: true, claimId: CLAIM_ID, attemptToken: TOKEN_1, attemptCount: 1 };
      }),
      [sender]: vi.fn(async () => {
        order.push("provider");
        return envelope.channel === "sms"
          ? { ok: true, messageSid: receipt }
          : { data: { id: receipt }, error: null };
      }),
      complete: vi.fn(async () => {
        order.push("complete");
        return { success: true, code: "completed" };
      }),
    });
    const result = await deliverBookingConfirmation({ bookingId: BOOKING_ID, salonId: SALON_ID, envelope }, d);
    expect(order).toEqual(["claim", "provider", "complete"]);
    expect(result).toMatchObject({ outcome: "accepted", providerMessageId: receipt, finalized: true });
  });

  it("fails closed before provider when the durable claim is unavailable", async () => {
    const d = deps({ claim: vi.fn().mockRejectedValue(new Error("db unavailable")) });
    const result = await deliverBookingConfirmation({ bookingId: BOOKING_ID, salonId: SALON_ID, envelope: sms }, d);
    expect(result).toMatchObject({ outcome: "suppressed", reason: "claim_unavailable" });
    expect(d.sendSms).not.toHaveBeenCalled();
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it("completes a provider-suppressed email claim without crossing Resend", async () => {
    const d = deps({
      emailSuppressionReason: vi.fn().mockResolvedValue("bounced"),
    });
    const result = await deliverBookingConfirmation({
      bookingId: BOOKING_ID,
      salonId: SALON_ID,
      envelope: email,
    }, d);
    expect(result).toMatchObject({
      outcome: "suppressed",
      reason: "bounced",
      finalized: true,
    });
    expect(d.sendEmail).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "suppressed",
      providerMessageId: null,
      failureDisposition: "permanent",
    }));
  });

  it("retries a suppression lookup outage without crossing Resend", async () => {
    const d = deps({
      emailSuppressionReason: vi.fn().mockResolvedValue("lookup_unavailable"),
    });
    const result = await deliverBookingConfirmation({
      bookingId: BOOKING_ID,
      salonId: SALON_ID,
      envelope: email,
    }, d);
    expect(result).toMatchObject({
      outcome: "rejected",
      reason: "suppression_lookup_unavailable",
      finalized: true,
    });
    expect(d.sendEmail).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      providerMessageId: null,
      errorCode: "suppression_lookup_unavailable",
      failureDisposition: "retryable_pre_acceptance",
    }));
  });

  it("classifies definite SMS and email pre-acceptance failures as the only retryable outcomes", async () => {
    const smsDeps = deps({ sendSms: vi.fn().mockResolvedValue({ ok: false, error: "twilio_429" }) });
    await deliverBookingConfirmation({ bookingId: BOOKING_ID, salonId: SALON_ID, envelope: sms }, smsDeps);
    expect(smsDeps.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      errorCode: "sms_rate_limited_pre_acceptance",
      failureDisposition: "retryable_pre_acceptance",
    }));

    const emailDeps = deps({ sendEmail: vi.fn().mockResolvedValue({ data: null, error: { statusCode: 503 } }) });
    await deliverBookingConfirmation({ bookingId: BOOKING_ID, salonId: SALON_ID, envelope: email }, emailDeps);
    expect(emailDeps.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      errorCode: "email_unavailable_pre_acceptance",
      failureDisposition: "retryable_pre_acceptance",
    }));
  });

  it("keeps thrown or contradictory provider outcomes unknown with no replay permission", async () => {
    const thrown = deps({ sendSms: vi.fn().mockRejectedValue(new Error("response lost")) });
    await deliverBookingConfirmation({ bookingId: BOOKING_ID, salonId: SALON_ID, envelope: sms }, thrown);
    expect(thrown.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "unknown",
      errorCode: "provider_exception",
      failureDisposition: "none",
    }));

    const contradictory = deps({
      sendEmail: vi.fn().mockResolvedValue({ data: { id: "maybe_accepted" }, error: { statusCode: 429 } }),
    });
    await deliverBookingConfirmation({ bookingId: BOOKING_ID, salonId: SALON_ID, envelope: email }, contradictory);
    expect(contradictory.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "unknown",
      errorCode: "provider_outcome_unknown",
      failureDisposition: "none",
    }));
  });

  it.each([sms, email])("replays an exact immutable %s envelope from a due lease", async (envelope) => {
    const d = deps();
    const result = await deliverLeasedBookingConfirmationRetry(lease(envelope), d);
    expect(result.outcome).toBe("accepted");
    expect(envelope.channel === "sms" ? d.sendSms : d.sendEmail).toHaveBeenCalledTimes(1);
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      claimId: CLAIM_ID,
      attemptToken: TOKEN_2,
      status: "sent",
    }));
  });

  it.each([
    [sms, "sendSms", { ok: false, error: "twilio_429" }, { ok: true, messageSid: `SM${"b".repeat(32)}` }, "sms_rate_limited_pre_acceptance"],
    [email, "sendEmail", { data: null, error: { statusCode: 503 } }, { data: { id: "resend_retry_accepted" }, error: null }, "email_unavailable_pre_acceptance"],
  ] as const)("executes the full definite-failure queue-to-second-attempt path for %s", async (
    envelope,
    sender,
    firstProviderResult,
    secondProviderResult,
    retryCode,
  ) => {
    const send = vi.fn()
      .mockResolvedValueOnce(firstProviderResult)
      .mockResolvedValueOnce(secondProviderResult);
    const complete = vi.fn().mockResolvedValue({ success: true, code: "completed" });
    const d = deps({ [sender]: send, complete });

    const first = await deliverBookingConfirmation({
      bookingId: BOOKING_ID,
      salonId: SALON_ID,
      envelope,
    }, d);
    expect(first).toMatchObject({ outcome: "rejected", reason: retryCode, finalized: true });
    expect(complete).toHaveBeenNthCalledWith(1, expect.objectContaining({
      attemptToken: TOKEN_1,
      status: "failed",
      errorCode: retryCode,
      failureDisposition: "retryable_pre_acceptance",
    }));

    const worker = await runBookingConfirmationRetryWorker(10, {
      reconcile: vi.fn().mockResolvedValue({ success: true, reconciled: 0 }),
      lease: vi.fn().mockResolvedValue([lease(envelope)]),
      delivery: d,
    });
    expect(worker).toMatchObject({ retriesProcessed: 1, accepted: 1 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenNthCalledWith(2, expect.objectContaining({
      attemptToken: TOKEN_2,
      status: "sent",
      errorCode: null,
      failureDisposition: "none",
    }));
  });

  it("never calls a provider for a tampered retry envelope", async () => {
    const raw = lease(sms);
    raw.dispatch_envelope = raw.dispatch_envelope.replace("Booked", "Changed");
    const d = deps();
    const result = await deliverLeasedBookingConfirmationRetry(raw, d);
    expect(result).toMatchObject({ outcome: "suppressed", reason: "material_changed" });
    expect(d.sendSms).not.toHaveBeenCalled();
    expect(d.sendEmail).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "suppressed",
      errorCode: "material_changed",
    }));
  });

  it("does not resend after a provider receipt when completion response is lost", async () => {
    const first = deps({ complete: vi.fn().mockRejectedValue(new Error("response lost")) });
    const result = await deliverBookingConfirmation({ bookingId: BOOKING_ID, salonId: SALON_ID, envelope: sms }, first);
    expect(result).toMatchObject({ outcome: "accepted", reason: "completion_unavailable", finalized: false });
    expect(first.sendSms).toHaveBeenCalledTimes(1);

    const replay = deps({
      claim: vi.fn().mockResolvedValue({ success: true, code: "in_flight", claimed: false, claimId: CLAIM_ID, attemptToken: null, attemptCount: 1 }),
    });
    await deliverBookingConfirmation({ bookingId: BOOKING_ID, salonId: SALON_ID, envelope: sms }, replay);
    expect(replay.sendSms).not.toHaveBeenCalled();
  });

  it("reconciles stale claims and drains a bounded mixed-channel lease batch", async () => {
    const delivery = deps();
    const result = await runBookingConfirmationRetryWorker(500, {
      reconcile: vi.fn().mockResolvedValue({ success: true, reconciled: 2 }),
      lease: vi.fn().mockResolvedValue([lease(sms), lease(email)]),
      delivery,
    });
    expect(result).toEqual({
      staleReconciled: 2,
      retriesProcessed: 2,
      accepted: 2,
      rejected: 0,
      suppressed: 0,
      unknown: 0,
    });
    expect(delivery.sendSms).toHaveBeenCalledTimes(1);
    expect(delivery.sendEmail).toHaveBeenCalledTimes(1);
  });
});

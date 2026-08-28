import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildCustomerBookingTransitionEmailPayload,
  customerBookingTransitionPayloadFingerprint,
  deliverCustomerBookingTransitionEmail,
  deliverLeasedCustomerBookingTransitionEmailRetry,
  runCustomerBookingTransitionEmailWorker,
  type CustomerBookingTransitionEmailDeps,
  type CustomerBookingTransitionMaterial,
} from "../customerBookingTransitionEmail";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const BOOKING_ID = "22222222-2222-4222-8222-222222222222";
const LOGO_URL = "https://project-ref.supabase.co/storage/v1/object/public/salon-imports/salon/logo.png";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function material(overrides: Partial<CustomerBookingTransitionMaterial> = {}): CustomerBookingTransitionMaterial {
  return {
    outboxId: "33333333-3333-4333-8333-333333333333",
    eventType: "reschedule",
    transitionVersion: 7,
    occurrenceKey: "7".repeat(64),
    status: "pending",
    recipientFingerprint: "0fa7160c9ec1e558e73121609d1d1472307d8ad642ccd0cec3c134ebe85b016d",
    materialFingerprint: "b".repeat(64),
    payloadFingerprint: null,
    snapshot: {
      recipientEmail: "mai@example.com",
      locale: "vi",
      clientName: "Mai",
      serviceId: "44444444-4444-4444-8444-444444444444",
      serviceName: "Gel Manicure",
      staffId: "55555555-5555-4555-8555-555555555555",
      staffName: "Linh",
      salonName: "Salon Ánh Dương",
      salonSlug: "salon-anh-duong",
      salonTimezone: "America/Vancouver",
      salonLogoUrl: LOGO_URL,
      salonPhone: "+16045550101",
      previousStatus: "confirmed",
      currentStatus: "confirmed",
      previousStartTimeUtc: "2026-08-20T17:00:00.000Z",
      newStartTimeUtc: "2026-08-21T18:30:00.000Z",
      transitionedAt: "2026-08-20T16:00:00.000Z",
    },
    ...overrides,
  };
}

function claimedMaterial(overrides: Partial<CustomerBookingTransitionMaterial> = {}) {
  const authoritative = material(overrides);
  const payload = buildCustomerBookingTransitionEmailPayload(
    authoritative.eventType as "cancel" | "reschedule",
    authoritative,
  );
  return {
    ...authoritative,
    payloadFingerprint: customerBookingTransitionPayloadFingerprint(payload!),
    attemptToken: "66666666-6666-4666-8666-666666666666",
    attemptCount: 1,
  };
}

function rawMaterial(value: CustomerBookingTransitionMaterial, extras: Record<string, unknown> = {}) {
  return {
    success: true,
    outbox_id: value.outboxId,
    event_type: value.eventType,
    transition_version: value.transitionVersion,
    occurrence_key: value.occurrenceKey,
    status: value.status,
    recipient_fingerprint: value.recipientFingerprint,
    material_fingerprint: value.materialFingerprint,
    payload_fingerprint: value.payloadFingerprint,
    snapshot: {
      recipient_email: value.snapshot.recipientEmail,
      locale: value.snapshot.locale,
      client_name: value.snapshot.clientName,
      service_id: value.snapshot.serviceId,
      service_name: value.snapshot.serviceName,
      staff_id: value.snapshot.staffId,
      staff_name: value.snapshot.staffName,
      salon_name: value.snapshot.salonName,
      salon_slug: value.snapshot.salonSlug,
      salon_timezone: value.snapshot.salonTimezone,
      salon_logo_url: value.snapshot.salonLogoUrl,
      salon_phone: value.snapshot.salonPhone,
      previous_status: value.snapshot.previousStatus,
      current_status: value.snapshot.currentStatus,
      previous_start_time_utc: value.snapshot.previousStartTimeUtc,
      new_start_time_utc: value.snapshot.newStartTimeUtc,
      transitioned_at: value.snapshot.transitionedAt,
    },
    ...extras,
  };
}

function deps(overrides: Partial<CustomerBookingTransitionEmailDeps> = {}) {
  const authoritative = material();
  const send = vi.fn().mockResolvedValue({ data: { id: "email_accepted_1" }, error: null });
  const complete = vi.fn().mockResolvedValue({ success: true, code: "completed" });
  const claim = vi.fn().mockResolvedValue({
    code: "claimed",
    claimed: true,
    material: claimedMaterial(),
  });
  const result: CustomerBookingTransitionEmailDeps & { send: typeof send } = {
    loadMaterial: vi.fn().mockResolvedValue(authoritative),
    claim,
    complete,
    provider: () => ({ send }),
    from: () => "NailIQ <noreply@example.com>",
    emailSuppressionReason: vi.fn().mockResolvedValue(null),
    ...overrides,
    send,
  };
  return result;
}

const input = {
  salonId: SALON_ID,
  bookingId: BOOKING_ID,
  transitionKind: "reschedule" as const,
  expectedTransitionVersion: 7,
};

describe("customer booking transition email", () => {
  it("renders deterministic localized material using only the occurrence snapshot", () => {
    const first = buildCustomerBookingTransitionEmailPayload("reschedule", material());
    const second = buildCustomerBookingTransitionEmailPayload("reschedule", material());
    expect(first).toEqual(second);
    expect(first?.subject).toContain("Lịch hẹn đã được dời");
    expect(first?.text).toContain("Gel Manicure");
    expect(first?.text).toContain("Salon Ánh Dương");
    expect(first?.text).toContain("20 thg 8");
    expect(first?.text).toContain("21 thg 8");
    expect(first?.html).toContain(LOGO_URL);
    expect(customerBookingTransitionPayloadFingerprint(first!)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("renders an English cancellation from the previous appointment occurrence", () => {
    const cancelled = material({
      eventType: "cancel",
      snapshot: {
        ...material().snapshot,
        locale: "en",
        currentStatus: "cancelled",
      },
    });
    const payload = buildCustomerBookingTransitionEmailPayload("cancel", cancelled);
    expect(payload?.subject).toBe("Appointment cancelled — Salon Ánh Dương");
    expect(payload?.text).toContain("has been cancelled");
    expect(payload?.text).toContain("Aug 20");
    expect(payload?.text).not.toContain("Aug 21");
  });

  it("claims before opening the provider boundary and finalizes exact receipt", async () => {
    const order: string[] = [];
    const d = deps({
      claim: vi.fn(async () => {
        order.push("claim");
        return {
          code: "claimed",
          claimed: true,
          material: claimedMaterial(),
        };
      }),
      provider: () => {
        order.push("provider");
        return { send: async () => {
          order.push("send");
          return { data: { id: "email_accepted_1" }, error: null };
        } };
      },
    });
    const result = await deliverCustomerBookingTransitionEmail(input, d);
    expect(order).toEqual(["claim", "provider", "send"]);
    expect(result).toMatchObject({ outcome: "sent", providerId: "email_accepted_1", finalized: true });
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "sent",
      providerMessageId: "email_accepted_1",
      errorCode: null,
      failureDisposition: "none",
    }));
  });

  it("allows only one provider call when concurrent attempts race for one claim", async () => {
    let claimed = false;
    const d = deps({
      claim: vi.fn(async () => {
        if (claimed) return { code: "in_flight", claimed: false, material: null };
        claimed = true;
        return {
          code: "claimed",
          claimed: true,
          material: claimedMaterial(),
        };
      }),
    });
    const [a, b] = await Promise.all([
      deliverCustomerBookingTransitionEmail(input, d),
      deliverCustomerBookingTransitionEmail(input, d),
    ]);
    expect(d.send).toHaveBeenCalledTimes(1);
    expect([a.outcome, b.outcome].sort()).toEqual(["sent", "suppressed"]);
  });

  it("never reaches provider when authoritative and claimed snapshots differ", async () => {
    const d = deps({
      claim: vi.fn().mockResolvedValue({
        code: "claimed",
        claimed: true,
        material: claimedMaterial({ occurrenceKey: "8".repeat(64) }),
      }),
    });
    const result = await deliverCustomerBookingTransitionEmail(input, d);
    expect(result.reason).toBe("claim_material_mismatch");
    expect(d.send).not.toHaveBeenCalled();
  });

  it.each([
    [{ data: null, error: { statusCode: 429 } }, "failed", "email_rate_limited_pre_acceptance", "retryable_pre_acceptance"],
    [{ data: null, error: { statusCode: 401 } }, "failed", "provider_auth_invalid", "permanent"],
    [{ data: {}, error: null }, "unknown", "invalid_provider_receipt", "none"],
    [{ data: { id: "contradictory_id" }, error: { statusCode: 429 } }, "unknown", "email_delivery_ambiguous", "none"],
  ] as const)("classifies provider result without inventing acceptance: %#", async (providerResult, outcome, code, disposition) => {
    const d = deps({ provider: () => ({ send: vi.fn().mockResolvedValue(providerResult) }) });
    const result = await deliverCustomerBookingTransitionEmail(input, d);
    expect(result.outcome).toBe(outcome);
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: outcome,
      errorCode: code,
      failureDisposition: disposition,
      providerMessageId: null,
    }));
  });

  it("records provider exceptions as unknown and never retries in-process", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network state unknown"));
    const d = deps({ provider: () => ({ send }) });
    const result = await deliverCustomerBookingTransitionEmail(input, d);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("unknown");
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "provider_exception",
      failureDisposition: "none",
    }));
  });

  it("treats missing provider configuration as a permanent pre-send failure", async () => {
    const d = deps({ provider: () => null });
    const result = await deliverCustomerBookingTransitionEmail(input, d);
    expect(result.outcome).toBe("failed");
    expect(d.send).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "provider_configuration_invalid",
      failureDisposition: "permanent",
    }));
  });

  it("does not call provider again after completion response loss", async () => {
    const d = deps({ complete: vi.fn().mockRejectedValue(new Error("write response lost")) });
    const first = await deliverCustomerBookingTransitionEmail(input, d);
    expect(first).toMatchObject({ outcome: "sent", finalized: false, reason: "completion_unavailable" });
    (d.claim as ReturnType<typeof vi.fn>).mockResolvedValue({ code: "in_flight", claimed: false, material: null });
    const second = await deliverCustomerBookingTransitionEmail(input, d);
    expect(second.outcome).toBe("suppressed");
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("uses distinct versioned occurrence material for A to B to A", () => {
    const a = buildCustomerBookingTransitionEmailPayload("reschedule", material());
    const againA = buildCustomerBookingTransitionEmailPayload("reschedule", material({
      transitionVersion: 9,
      occurrenceKey: "9".repeat(64),
      snapshot: { ...material().snapshot, previousStartTimeUtc: "2026-08-21T18:30:00.000Z" },
    }));
    expect(customerBookingTransitionPayloadFingerprint(a!)).not.toBe(customerBookingTransitionPayloadFingerprint(againA!));
  });

  it("finalizes a complaint-suppressed claim without calling Resend", async () => {
    const d = deps({
      emailSuppressionReason: vi.fn().mockResolvedValue("complained"),
    });
    const result = await deliverCustomerBookingTransitionEmail(input, d);
    expect(result).toMatchObject({
      outcome: "suppressed",
      reason: "complained",
      finalized: true,
    });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "suppressed",
      providerMessageId: null,
      failureDisposition: "permanent",
    }));
  });

  it("retries a suppression lookup outage without calling Resend", async () => {
    const d = deps({
      emailSuppressionReason: vi.fn().mockResolvedValue("lookup_unavailable"),
    });
    const result = await deliverCustomerBookingTransitionEmail(input, d);
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "suppression_lookup_unavailable",
      finalized: true,
    });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      providerMessageId: null,
      errorCode: "suppression_lookup_unavailable",
      failureDisposition: "retryable_pre_acceptance",
    }));
  });

  it("sends a leased retry only when stored payload and recipient fingerprints still match", async () => {
    const claimed = claimedMaterial({ status: "sending" });
    const d = deps();
    const result = await deliverLeasedCustomerBookingTransitionEmailRetry(rawMaterial(claimed, {
      code: "leased",
      salon_id: SALON_ID,
      attempt_token: claimed.attemptToken,
      attempt_count: 2,
    }), d);
    expect(result.outcome).toBe("sent");
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("suppresses a leased retry whose deterministic payload changed", async () => {
    const claimed = claimedMaterial({ status: "sending" });
    const d = deps();
    const result = await deliverLeasedCustomerBookingTransitionEmailRetry(rawMaterial(claimed, {
      code: "leased",
      salon_id: SALON_ID,
      attempt_token: claimed.attemptToken,
      attempt_count: 2,
      payload_fingerprint: "f".repeat(64),
    }), d);
    expect(result).toMatchObject({ outcome: "suppressed", reason: "material_changed" });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "suppressed",
      errorCode: "material_changed",
    }));
  });

  it("reconciles stale claims and processes due initial plus bounded retry work", async () => {
    const initial = material();
    const retry = claimedMaterial({ status: "sending" });
    const d = deps();
    const result = await runCustomerBookingTransitionEmailWorker(500, {
      reconcileStale: vi.fn().mockResolvedValue({ success: true, reconciled: 2 }),
      discoverDue: vi.fn().mockResolvedValue([rawMaterial(initial, { salon_id: SALON_ID, booking_id: BOOKING_ID })]),
      leaseRetries: vi.fn().mockResolvedValue([rawMaterial(retry, {
        code: "leased",
        salon_id: SALON_ID,
        booking_id: BOOKING_ID,
        attempt_token: retry.attemptToken,
        attempt_count: 2,
      })]),
      email: d,
    });
    expect(result).toMatchObject({ staleReconciled: 2, initialProcessed: 1, retriesProcessed: 1, sent: 2 });
    expect(d.send).toHaveBeenCalledTimes(2);
  });
});

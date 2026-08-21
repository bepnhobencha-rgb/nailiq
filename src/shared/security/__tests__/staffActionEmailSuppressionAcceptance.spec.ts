import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isEmailSuppressed: vi.fn(),
  getResendClient: vi.fn(),
  providerSend: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/emailCompliance", () => ({
  isEmailSuppressed: mocks.isEmailSuppressed,
  listUnsubscribeHeaders: () => ({
    "List-Unsubscribe": "<https://nailiq.test/unsubscribe>",
  }),
  complianceFooterHtml: () => "<footer>Transactional notice</footer>",
}));
vi.mock("@/shared/lib/resend", () => ({
  getResendFrom: () => "NailIQ <notices@example.com>",
  getResendClient: mocks.getResendClient,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => {
    throw new Error("inject client in tests");
  },
}));
vi.mock("@/shared/lib/twilioSms", () => ({ sendSmsReminder: vi.fn() }));

import { runStaffActionNotificationWorker } from "@/shared/notifications/staffActionNotificationWorker";

const ids = {
  delivery: "11111111-1111-4111-8111-111111111111",
  outbox: "22222222-2222-4222-8222-222222222222",
  salon: "33333333-3333-4333-8333-333333333333",
  booking: "44444444-4444-4444-8444-444444444444",
  request: "55555555-5555-4555-8555-555555555555",
  actor: "66666666-6666-4666-8666-666666666666",
  service: "77777777-7777-4777-8777-777777777777",
  staff: "88888888-8888-4888-8888-888888888888",
  attempt: "99999999-9999-4999-8999-999999999999",
};

function material() {
  return {
    success: true,
    code: "loaded",
    delivery_id: ids.delivery,
    channel: "email",
    status: "awaiting_material",
    outbox_id: ids.outbox,
    salon_id: ids.salon,
    booking_id: ids.booking,
    request_id: ids.request,
    event: "cancel",
    occurrence_version: 2,
    actor_user_id: ids.actor,
    actor_role: "receptionist",
    material_fingerprint: "a".repeat(64),
    send_after: "2026-08-20T17:00:00+00:00",
    expires_at: "2026-08-20T17:30:00+00:00",
    material: {
      contract_version: 1,
      salon_id: ids.salon,
      booking_id: ids.booking,
      request_id: ids.request,
      event: "cancel",
      occurrence_version: 2,
      actor_user_id: ids.actor,
      actor_role: "receptionist",
      client_name: "Mai",
      client_phone: "16045550199",
      client_email: "mai@example.com",
      locale: "en",
      start_time_utc: "2026-08-22T17:30:00+00:00",
      service_id: ids.service,
      service_name: "Gel manicure",
      staff_id: ids.staff,
      staff_name: "Linh",
      salon_name: "NailIQ QA",
      salon_slug: "nailiq-qa",
      salon_timezone: "America/Vancouver",
      salon_phone: "+16045550000",
      salon_logo_url: null,
      salon_is_test: true,
      sms_outbound_enabled: true,
      email_outbound_enabled: true,
      requested_channels: { sms: false, email: true },
    },
  };
}

function client() {
  let envelope = "";
  let fingerprint = "";
  let completion: Record<string, unknown> | null = null;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    switch (name) {
      case "reconcile_stale_staff_action_notification_deliveries":
        return {
          data: { success: true, code: "reconciled", reconciled: 0 },
          error: null,
        };
      case "discover_staff_action_notifications_awaiting_material":
        return {
          data: [{
            success: true,
            code: "material_required",
            deliveries: [{ delivery_id: ids.delivery, channel: "email" }],
          }],
          error: null,
        };
      case "load_staff_action_notification_material":
        return { data: material(), error: null };
      case "materialize_staff_action_notification_delivery":
        envelope = String(args.p_dispatch_envelope);
        fingerprint = String(args.p_payload_fingerprint);
        return { data: { success: true, code: "materialized" }, error: null };
      case "lease_due_staff_action_notification_deliveries":
        return {
          data: [{
            success: true,
            code: "delivery_claimed",
            delivery_id: ids.delivery,
            event_id: ids.outbox,
            attempt_token: ids.attempt,
            attempt_count: 1,
            envelope_fingerprint: fingerprint,
            dispatch_envelope: envelope,
          }],
          error: null,
        };
      case "complete_staff_action_notification_delivery":
        completion = args;
        return { data: { success: true, code: "completed" }, error: null };
      default:
        throw new Error(`unexpected RPC ${name}`);
    }
  });
  return { rpc, completion: () => completion };
}

describe("staff-action email suppression acceptance", () => {
  it("does not call Resend for a known suppressed recipient and completes permanently suppressed", async () => {
    mocks.isEmailSuppressed.mockResolvedValueOnce(true);
    const db = client();

    const result = await runStaffActionNotificationWorker(10, {
      client: db as never,
      siteUrl: "https://nailiq.test",
    });

    expect(mocks.isEmailSuppressed).toHaveBeenCalledWith("mai@example.com");
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(db.completion()).toMatchObject({
      p_status: "suppressed",
      p_error_code: "consent_revoked",
      p_failure_disposition: "permanent",
    });
    expect(result).toMatchObject({ ok: true, suppressed: 1, claimed: 1 });
  });

  it("fails closed before Resend and schedules only a definite pre-acceptance retry when suppression truth is unavailable", async () => {
    mocks.isEmailSuppressed.mockRejectedValueOnce(new Error("lookup unavailable"));
    const db = client();

    const result = await runStaffActionNotificationWorker(10, {
      client: db as never,
      siteUrl: "https://nailiq.test",
    });

    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(db.completion()).toMatchObject({
      p_status: "failed",
      p_error_code: "email_unavailable_pre_acceptance",
      p_failure_disposition: "retryable_pre_acceptance",
    });
    expect(result).toMatchObject({ ok: true, rejected: 1, claimed: 1 });
  });

  it("does not retry a permanent Resend configuration failure", async () => {
    mocks.isEmailSuppressed.mockResolvedValueOnce(false);
    mocks.getResendClient.mockReturnValueOnce(null);
    const db = client();

    const result = await runStaffActionNotificationWorker(10, {
      client: db as never,
      siteUrl: "https://nailiq.test",
    });

    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(db.completion()).toMatchObject({
      p_status: "failed",
      p_error_code: "provider_configuration_invalid",
      p_failure_disposition: "permanent",
    });
    expect(result).toMatchObject({ ok: true, rejected: 1, claimed: 1 });
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/resend", () => ({
  getResendClient: () => null,
  getResendFrom: () => "NailIQ <notices@example.com>",
}));
vi.mock("@/shared/lib/emailCompliance", () => ({
  listUnsubscribeHeaders: () => ({ "List-Unsubscribe": "<https://nailiq.test/unsubscribe>" }),
  complianceFooterHtml: () => "<footer>Transactional notice</footer>",
  isEmailSuppressed: vi.fn().mockResolvedValue(false),
  transactionalEmailSuppressionReason: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => { throw new Error("inject client in tests"); },
}));
vi.mock("@/shared/lib/twilioSms", () => ({
  sendSmsReminder: vi.fn(),
}));

import { createHash } from "node:crypto";
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
    channel: "sms",
    status: "awaiting_material",
    outbox_id: ids.outbox,
    salon_id: ids.salon,
    booking_id: ids.booking,
    request_id: ids.request,
    event: "create",
    occurrence_version: 0,
    actor_user_id: ids.actor,
    actor_role: "owner",
    material_fingerprint: "a".repeat(64),
    send_after: "2026-08-20T17:00:00+00:00",
    expires_at: "2026-08-20T17:30:00+00:00",
    material: {
      contract_version: 1,
      salon_id: ids.salon,
      booking_id: ids.booking,
      request_id: ids.request,
      event: "create",
      occurrence_version: 0,
      actor_user_id: ids.actor,
      actor_role: "owner",
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
      requested_channels: { sms: true, email: false },
    },
  };
}

function client(options?: {
  reconcileError?: boolean;
  discoveryError?: boolean;
  leaseError?: boolean;
  materialValue?: ReturnType<typeof material>;
}) {
  const order: string[] = [];
  let envelope = "";
  let fingerprint = "";
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    order.push(name);
    switch (name) {
      case "reconcile_stale_staff_action_notification_deliveries":
        return options?.reconcileError
          ? { data: null, error: new Error("unavailable") }
          : { data: { success: true, code: "reconciled", reconciled: 1 }, error: null };
      case "discover_staff_action_notifications_awaiting_material":
        return options?.discoveryError
          ? { data: null, error: new Error("unavailable") }
          : {
              data: [{
                success: true,
                code: "material_required",
                deliveries: [{ delivery_id: ids.delivery, channel: "sms" }],
              }],
              error: null,
            };
      case "load_staff_action_notification_material":
        return { data: options?.materialValue ?? material(), error: null };
      case "materialize_staff_action_notification_delivery":
        envelope = String(args.p_dispatch_envelope);
        fingerprint = String(args.p_payload_fingerprint);
        return { data: { success: true, code: "materialized" }, error: null };
      case "suppress_unmaterializable_staff_action_delivery":
        return { data: { success: true, code: "suppressed" }, error: null };
      case "lease_due_staff_action_notification_deliveries":
        return options?.leaseError
          ? { data: null, error: new Error("unavailable") }
          : {
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
        return { data: { success: true, code: "completed" }, error: null };
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  });
  return { rpc, order };
}

describe("staff-action notification worker", () => {
  it("reconciles, materializes, leases, dispatches and completes in that order", async () => {
    const db = client();
    const sendSms = vi.fn().mockResolvedValue({
      ok: true,
      messageSid: `SM${"a".repeat(32)}`,
    });
    const result = await runStaffActionNotificationWorker(10, {
      client: db as never,
      siteUrl: "https://nailiq.test",
      sendSms,
    });

    expect(result).toMatchObject({
      ok: true,
      code: "processed",
      reconciled: 1,
      materialized: 1,
      claimed: 1,
      accepted: 1,
      completionUnavailable: 0,
    });
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(db.order).toEqual([
      "reconcile_stale_staff_action_notification_deliveries",
      "discover_staff_action_notifications_awaiting_material",
      "load_staff_action_notification_material",
      "materialize_staff_action_notification_delivery",
      "lease_due_staff_action_notification_deliveries",
      "complete_staff_action_notification_delivery",
    ]);
    const materializeCall = db.rpc.mock.calls.find(([name]) =>
      name === "materialize_staff_action_notification_delivery")!;
    const args = materializeCall[1] as Record<string, string>;
    expect(createHash("sha256").update(args.p_dispatch_envelope).digest("hex"))
      .toBe(args.p_payload_fingerprint);
  });

  it("materializes staff_change and dispatches only through the injected provider mock", async () => {
    const value = material();
    value.event = "staff_change";
    value.material.event = "staff_change";
    const db = client({ materialValue: value });
    const sendSms = vi.fn().mockResolvedValue({
      ok: true,
      messageSid: `SM${"b".repeat(32)}`,
    });

    await expect(runStaffActionNotificationWorker(1, {
      client: db as never,
      siteUrl: "https://nailiq.test",
      sendSms,
    })).resolves.toMatchObject({
      ok: true,
      materialized: 1,
      claimed: 1,
      accepted: 1,
    });
    expect(sendSms).toHaveBeenCalledTimes(1);
    const materializeCall = db.rpc.mock.calls.find(([name]) =>
      name === "materialize_staff_action_notification_delivery")!;
    const envelope = JSON.parse(
      String((materializeCall[1] as Record<string, unknown>).p_dispatch_envelope),
    );
    expect(envelope).toMatchObject({ event: "staff_change", channel: "sms" });
    expect(envelope.body).toContain("Linh");
  });

  it.each([
    ["reconciliation", { reconcileError: true }, "reconciliation_unavailable"],
    ["discovery", { discoveryError: true }, "discovery_unavailable"],
    ["lease", { leaseError: true }, "lease_unavailable"],
  ])("fails closed on %s RPC outage", async (_label, options, code) => {
    const db = client(options);
    const sendSms = vi.fn();
    const result = await runStaffActionNotificationWorker(10, {
      client: db as never,
      siteUrl: "https://nailiq.test",
      sendSms,
    });

    expect(result).toMatchObject({ ok: false, code });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("atomically suppresses a missing-recipient delivery without provider dispatch", async () => {
    const value = material();
    value.material.client_phone = null as never;
    const db = client({ materialValue: value });
    const sendSms = vi.fn();

    await expect(runStaffActionNotificationWorker(10, {
      client: db as never,
      siteUrl: "https://nailiq.test",
      sendSms,
    })).resolves.toMatchObject({
      ok: true,
      materialized: 0,
      unmaterializableSuppressed: 1,
      awaitingExpiry: 0,
      claimed: 0,
    });
    expect(sendSms).not.toHaveBeenCalled();
    expect(db.order).not.toContain("materialize_staff_action_notification_delivery");
    expect(db.rpc).toHaveBeenCalledWith(
      "suppress_unmaterializable_staff_action_delivery",
      { p_delivery_id: ids.delivery, p_reason: "recipient_missing" },
    );
  });

  it("suppresses a disabled staff_change channel before either provider boundary", async () => {
    const value = material();
    value.event = "staff_change";
    value.material.event = "staff_change";
    value.material.sms_outbound_enabled = false;
    const db = client({ materialValue: value });
    const sendSms = vi.fn();
    const sendEmail = vi.fn();

    await expect(runStaffActionNotificationWorker(10, {
      client: db as never,
      siteUrl: "https://nailiq.test",
      sendSms,
      sendEmail,
    })).resolves.toMatchObject({
      ok: true,
      materialized: 0,
      unmaterializableSuppressed: 1,
      claimed: 0,
    });
    expect(sendSms).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.order).not.toContain("materialize_staff_action_notification_delivery");
    expect(db.rpc).toHaveBeenCalledWith(
      "suppress_unmaterializable_staff_action_delivery",
      { p_delivery_id: ids.delivery, p_reason: "channel_disabled" },
    );
  });
});

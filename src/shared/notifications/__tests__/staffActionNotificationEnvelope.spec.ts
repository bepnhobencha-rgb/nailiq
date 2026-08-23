import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/resend", () => ({
  getResendFrom: () => "NailIQ <notices@example.com>",
}));
vi.mock("@/shared/lib/emailCompliance", () => ({
  listUnsubscribeHeaders: () => ({ "List-Unsubscribe": "<https://nailiq.test/unsubscribe>" }),
  complianceFooterHtml: () => "<footer>Transactional notice</footer>",
  isEmailSuppressed: vi.fn().mockResolvedValue(false),
}));

import {
  buildStaffActionNotificationEnvelope,
  parseStaffActionNotificationMaterial,
} from "@/shared/notifications/staffActionNotificationEnvelope";

const IDS = {
  delivery: "11111111-1111-4111-8111-111111111111",
  outbox: "22222222-2222-4222-8222-222222222222",
  salon: "33333333-3333-4333-8333-333333333333",
  booking: "44444444-4444-4444-8444-444444444444",
  request: "55555555-5555-4555-8555-555555555555",
  actor: "66666666-6666-4666-8666-666666666666",
  service: "77777777-7777-4777-8777-777777777777",
  staff: "88888888-8888-4888-8888-888888888888",
};

function raw(channel: "sms" | "email" = "sms") {
  const material = {
    contract_version: 1,
    salon_id: IDS.salon,
    booking_id: IDS.booking,
    request_id: IDS.request,
    event: "reschedule",
    occurrence_version: 4,
    actor_user_id: IDS.actor,
    actor_role: "receptionist",
    client_name: "Mai",
    client_phone: "16045550199",
    client_email: "mai@example.com",
    locale: "vi",
    start_time_utc: "2026-08-22T17:30:00+00:00",
    service_id: IDS.service,
    service_name: "Gel manicure",
    staff_id: IDS.staff,
    staff_name: "Linh",
    salon_name: "NailIQ QA",
    salon_slug: "nailiq-qa",
    salon_timezone: "America/Vancouver",
    salon_phone: "+16045550000",
    salon_logo_url: null,
    salon_is_test: true,
    sms_outbound_enabled: true,
    email_outbound_enabled: true,
    requested_channels: { sms: true, email: true },
  };
  return {
    success: true,
    code: "loaded",
    delivery_id: IDS.delivery,
    channel,
    status: "awaiting_material",
    outbox_id: IDS.outbox,
    salon_id: IDS.salon,
    booking_id: IDS.booking,
    request_id: IDS.request,
    event: "reschedule",
    occurrence_version: 4,
    actor_user_id: IDS.actor,
    actor_role: "receptionist",
    material,
    material_fingerprint: "a".repeat(64),
    send_after: "2026-08-20T17:00:00+00:00",
    expires_at: "2026-08-20T17:30:00+00:00",
  };
}

describe("staff-action immutable material and envelope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders a canonical SMS solely from the stored occurrence snapshot", () => {
    const material = parseStaffActionNotificationMaterial(raw("sms"));
    expect(material).not.toBeNull();

    const rendered = buildStaffActionNotificationEnvelope(material!, {
      siteUrl: "https://nailiq.test",
    });
    expect(rendered).not.toBeNull();
    const envelope = JSON.parse(rendered!.envelope);
    expect(envelope).toMatchObject({
      kind: "staff_action",
      channel: "sms",
      salonId: IDS.salon,
      bookingId: IDS.booking,
      event: "reschedule",
      actorUserId: IDS.actor,
      actorRole: "receptionist",
      to: "+16045550199",
      salonIsTest: true,
      lang: "vi",
    });
    expect(envelope.body).toContain("Gel manicure");
    expect(envelope.body).not.toContain("Reply STOP");
    expect(envelope.body).toContain("Nhắn STOP");
    expect(rendered!.recipientFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("renders the email channel with the same immutable identity and snapshot copy", () => {
    const material = parseStaffActionNotificationMaterial(raw("email"));
    const rendered = buildStaffActionNotificationEnvelope(material!, {
      siteUrl: "https://nailiq.test",
    });
    const envelope = JSON.parse(rendered!.envelope);

    expect(envelope).toMatchObject({
      kind: "staff_action",
      channel: "email",
      to: "mai@example.com",
      from: "NailIQ <notices@example.com>",
      event: "reschedule",
      actorUserId: IDS.actor,
    });
    expect(envelope.subject).toContain("NailIQ QA");
    expect(envelope.html).toContain("Gel manicure");
    expect(envelope.text).toContain("Gel manicure");
  });

  it("renders staff_change from the immutable replacement-staff snapshot", () => {
    const value = raw("email");
    value.event = "staff_change";
    value.material.event = "staff_change";
    const material = parseStaffActionNotificationMaterial(value);
    const rendered = buildStaffActionNotificationEnvelope(material!, {
      siteUrl: "https://nailiq.test",
    });
    const envelope = JSON.parse(rendered!.envelope);

    expect(envelope).toMatchObject({
      event: "staff_change",
      channel: "email",
      actorUserId: IDS.actor,
    });
    expect(envelope.subject).toContain("nhân viên");
    expect(envelope.text).toContain("Linh");
    expect(envelope.text).toContain("vẫn giữ nguyên");
    expect(envelope.html).toContain("Nhân viên phục vụ đã được cập nhật");
  });

  it.each([
    ["top-level identity drift", (value: ReturnType<typeof raw>) => { value.booking_id = IDS.salon; }],
    ["missing staff correlation", (value: ReturnType<typeof raw>) => { value.material.staff_name = null as never; }],
    ["disabled requested channel", (value: ReturnType<typeof raw>) => { value.material.requested_channels.sms = false; }],
    ["invalid timezone", (value: ReturnType<typeof raw>) => { value.material.salon_timezone = "not/a-zone"; }],
    ["invalid provider instant", (value: ReturnType<typeof raw>) => { value.material.start_time_utc = "2026-02-30T10:00:00Z"; }],
  ])("rejects %s before an envelope can be materialized", (_label, mutate) => {
    const value = raw("sms");
    mutate(value);
    expect(parseStaffActionNotificationMaterial(value)).toBeNull();
  });
});

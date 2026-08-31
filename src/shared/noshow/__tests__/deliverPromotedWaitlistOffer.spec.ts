import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  sms: vi.fn(),
  email: vi.fn(),
  suppressed: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/shared/lib/twilioSms", () => ({ sendSmsReminder: mocks.sms }));
vi.mock("@/shared/lib/resend", () => ({
  getResendClient: () => ({ emails: { send: mocks.email } }),
  getResendFrom: () => "NailIQ <test@nailiq.test>",
}));
vi.mock("@/shared/lib/emailCompliance", () => ({
  isEmailSuppressed: mocks.suppressed,
  complianceFooterHtml: () => "<footer>email preferences</footer>",
  listUnsubscribeHeaders: () => ({ "List-Unsubscribe": "<https://example.test/unsubscribe>" }),
}));

import { deliverPromotedWaitlistOffer } from "../deliverPromotedWaitlistOffer";

const input = {
  salonId: "22222222-2222-4222-8222-222222222222",
  offer: {
    waitlistEntryId: "11111111-1111-4111-8111-111111111111",
    claimCapabilityToken: "55555555-5555-4555-8555-555555555555",
    offerEpoch: 2,
  },
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function loadedMaterial(channel: "sms" | "email", snapshotOverride: Record<string, unknown> = {}) {
  const recipient = channel === "sms" ? "+16045550123" : "mai@example.test";
  return {
    ok: true,
    code: "material_loaded",
    material_fingerprint: "a".repeat(64),
    recipient_fingerprint: sha256(recipient),
    snapshot: {
      salon_id: input.salonId,
      waitlist_entry_id: input.offer.waitlistEntryId,
      offer_epoch: input.offer.offerEpoch,
      channel,
      claim_capability_id: input.offer.claimCapabilityToken,
      salon_name: "QA Salon",
      salon_slug: "qa-salon",
      salon_timezone: "America/Los_Angeles",
      salon_logo_url: null,
      salon_phone: null,
      sms_outbound_enabled: true,
      email_outbound_enabled: true,
      locale: "en",
      service_id: "33333333-3333-4333-8333-333333333333",
      service_name: "Manicure",
      client_name: "Mai",
      recipient,
      booking_date: "2099-08-20",
      offered_staff_id: "44444444-4444-4444-8444-444444444444",
      staff_name: "Anna",
      offered_start_utc: "2099-08-20T17:00:00.000Z",
      offered_end_utc: "2099-08-20T18:00:00.000Z",
      ...snapshotOverride,
    },
  };
}

describe("durable promoted waitlist offer delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.suppressed.mockResolvedValue(false);
    mocks.sms.mockResolvedValue({ ok: true, messageSid: `SM${"a".repeat(32)}` });
    mocks.email.mockResolvedValue({ data: { id: "re-test" }, error: null });
    const claimed = new Set<string>();
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "load_waitlist_offer_delivery_material") {
        const channel = String(args.p_channel);
        return {
          data: loadedMaterial(channel as "sms" | "email"),
          error: null,
        };
      }
      if (name === "claim_waitlist_offer_delivery") {
        const channel = String(args.p_channel);
        if (claimed.has(channel)) return { data: { ok: false, code: "terminal" }, error: null };
        claimed.add(channel);
        return {
          data: {
            ok: true,
            code: "claimed",
            outbox_id: channel === "sms"
              ? "66666666-6666-4666-8666-666666666666"
              : "77777777-7777-4777-8777-777777777777",
            attempt_token: channel === "sms"
              ? "88888888-8888-4888-8888-888888888888"
              : "99999999-9999-4999-8999-999999999999",
          },
          error: null,
        };
      }
      return { data: { ok: true, code: "completed" }, error: null };
    });
  });

  it("uses the exact capability link and one durable send per channel across replay", async () => {
    await deliverPromotedWaitlistOffer(input);
    await deliverPromotedWaitlistOffer(input);
    expect(mocks.sms).toHaveBeenCalledTimes(1);
    expect(mocks.email).toHaveBeenCalledTimes(1);
    const smsBody = String(mocks.sms.mock.calls[0]?.[1]);
    expect(smsBody).toContain(`/booking/waitlist-claim?token=${input.offer.claimCapabilityToken}`);
    expect(smsBody).not.toContain("claim_token");
    const claims = mocks.rpc.mock.calls.filter(([name]) => name === "claim_waitlist_offer_delivery");
    expect(claims).toHaveLength(4);
    expect(claims.every(([, args]) => args.p_offer_epoch === 2)).toBe(true);
    expect(claims.every(([, args]) => args.p_material_fingerprint === "a".repeat(64))).toBe(true);
    expect(claims.every(([, args]) => !String(args.p_recipient_fingerprint).includes("mai@"))).toBe(true);
  });

  it("never marks sent when provider success lacks an exact receipt", async () => {
    mocks.sms.mockResolvedValue({ ok: true, messageSid: "" });
    mocks.email.mockResolvedValue({ data: null, error: null });
    await deliverPromotedWaitlistOffer(input);
    const completes = mocks.rpc.mock.calls.filter(([name]) => name === "complete_waitlist_offer_delivery");
    expect(completes).toHaveLength(2);
    expect(completes.every(([, args]) => args.p_status === "unknown")).toBe(true);
    expect(completes.every(([, args]) => args.p_provider_receipt == null)).toBe(true);
  });

  it("durably marks a STOP-suppressed SMS without treating its local marker as a provider receipt", async () => {
    mocks.sms.mockResolvedValue({
      ok: true,
      messageSid: "SUPPRESSED_provider_stop_local-marker",
      suppressed: true,
      suppressionReason: "provider_stop",
    });
    await deliverPromotedWaitlistOffer(input);
    const completes = mocks.rpc.mock.calls.filter(([name]) => name === "complete_waitlist_offer_delivery");
    const smsComplete = completes.find(([, args]) => args.p_outbox_id === "66666666-6666-4666-8666-666666666666");
    expect(smsComplete?.[1]).toMatchObject({
      p_status: "suppressed",
      p_provider_receipt: null,
      p_error_code: "provider_stop",
    });
  });

  it.each([
    ["salon", { salon_name: null }],
    ["service", { service_name: null }],
    ["staff", { staff_name: null }],
  ] as const)("fails closed before claims or providers when authoritative %s material is absent", async (_label, override) => {
    const baseline = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) =>
      name === "load_waitlist_offer_delivery_material"
        ? { data: loadedMaterial(String(args.p_channel) as "sms" | "email", override), error: null }
        : baseline(name, args));
    await deliverPromotedWaitlistOffer(input);
    expect(mocks.sms).not.toHaveBeenCalled();
    expect(mocks.email).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.some(([name]) => name === "claim_waitlist_offer_delivery")).toBe(false);
  });

  it.each([null, undefined])(
    "treats missing/null outbound flags as deny-by-default (%s)",
    async (flag) => {
      const baseline = mocks.rpc.getMockImplementation()!;
      mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) =>
        name === "load_waitlist_offer_delivery_material"
          ? {
              data: loadedMaterial(String(args.p_channel) as "sms" | "email", {
                sms_outbound_enabled: flag,
                email_outbound_enabled: flag,
              }),
              error: null,
            }
          : baseline(name, args));
      await deliverPromotedWaitlistOffer(input);
      expect(mocks.sms).not.toHaveBeenCalled();
      expect(mocks.email).not.toHaveBeenCalled();
      expect(mocks.rpc.mock.calls.some(([name]) => name === "claim_waitlist_offer_delivery")).toBe(false);
    },
  );

  it("durably suppresses both channels when authoritative outbound flags are false", async () => {
    const baseline = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) =>
      name === "load_waitlist_offer_delivery_material"
        ? {
            data: loadedMaterial(String(args.p_channel) as "sms" | "email", {
              sms_outbound_enabled: false,
              email_outbound_enabled: false,
            }),
            error: null,
          }
        : baseline(name, args));
    await deliverPromotedWaitlistOffer(input);
    expect(mocks.sms).not.toHaveBeenCalled();
    expect(mocks.email).not.toHaveBeenCalled();
    const completes = mocks.rpc.mock.calls.filter(([name]) => name === "complete_waitlist_offer_delivery");
    expect(completes).toHaveLength(2);
    expect(completes.every(([, args]) => args.p_status === "suppressed")).toBe(true);
  });

  it("binds each rendered channel to the authoritative material loader snapshot", async () => {
    await deliverPromotedWaitlistOffer(input);
    const loads = mocks.rpc.mock.calls.filter(([name]) => name === "load_waitlist_offer_delivery_material");
    expect(loads).toHaveLength(2);
    expect(loads.map(([, args]) => args.p_channel).sort()).toEqual(["email", "sms"]);
    expect(loads.every(([, args]) => args.p_claim_capability_id === input.offer.claimCapabilityToken)).toBe(true);
    const claims = mocks.rpc.mock.calls.filter(([name]) => name === "claim_waitlist_offer_delivery");
    expect(claims).toHaveLength(2);
    expect(claims.every(([, args]) => args.p_material_fingerprint === "a".repeat(64))).toBe(true);
    expect(claims.map(([, args]) => args.p_recipient_fingerprint).sort()).toEqual([
      sha256("+16045550123"),
      sha256("mai@example.test"),
    ].sort());
    expect(mocks.sms).toHaveBeenCalledTimes(1);
    expect(mocks.email).toHaveBeenCalledTimes(1);
  });

  it("fails closed before claim or provider when authoritative material loading errors", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "load_waitlist_offer_delivery_material") {
        return { data: null, error: { message: "unavailable" } };
      }
      throw new Error(`unexpected RPC after material failure: ${name}`);
    });

    await deliverPromotedWaitlistOffer(input);

    const loads = mocks.rpc.mock.calls.filter(([name]) => name === "load_waitlist_offer_delivery_material");
    expect(loads).toHaveLength(2);
    expect(mocks.rpc.mock.calls.some(([name]) => name === "claim_waitlist_offer_delivery")).toBe(false);
    expect(mocks.sms).not.toHaveBeenCalled();
    expect(mocks.email).not.toHaveBeenCalled();
  });
});

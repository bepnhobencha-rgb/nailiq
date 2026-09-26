import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/lib/resend", () => ({
  getResendClient: () => ({ emails: { send: mocks.send } }),
  getResendFrom: () => "NailIQ <noreply@nailiq.ca>",
}));

import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import type { OwnerNotificationEvent } from "@/shared/dashboard/ownerNotificationSettings";

const salonId = "11111111-1111-4111-8111-111111111111";
const bookingId = "22222222-2222-4222-8222-222222222222";
const occurrence = "2026-09-26T19:00:00.000Z";

function setup(options: { slug?: string; enabled?: boolean; cancelEnabled?: boolean; status?: string; duplicate?: boolean } = {}) {
  const bookingQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        client_name: "Synthetic guest",
        status: options.status ?? "cancelled",
        start_time_utc: "2026-09-27T19:00:00Z",
        end_time_utc: "2026-09-27T20:00:00Z",
      },
      error: null,
    }),
  };
  const salonQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        name: "Synthetic salon",
        slug: options.slug ?? "e2e-email-fee",
        timezone: "America/Los_Angeles",
        currency_code: "USD",
        owner_notification_settings: {
          enabled: options.enabled ?? true,
          notifyMembers: false,
          customEmails: ["owner@example.com"],
          events: { new: true, reschedule: true, cancel: options.cancelEnabled ?? true, no_show: true },
        },
      },
    }),
  };
  const rpc = vi.fn(async (name: string) => {
    if (name === "claim_owner_booking_notification") {
      return {
        data: options.duplicate
          ? { success: true, claimed: false, code: "duplicate_suppressed", status: "sent" }
          : { success: true, claimed: true, claim_id: "33333333-3333-4333-8333-333333333333" },
        error: null,
      };
    }
    if (name === "complete_owner_booking_notification") {
      return { data: { success: true, status: "sent" }, error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  });
  const from = vi.fn((table: string) => {
    if (table === "salons") return salonQuery;
    if (table === "bookings") return bookingQuery;
    if (table === "owner_notification_log") return { insert: vi.fn().mockResolvedValue({ error: null }) };
    throw new Error(`Unexpected table: ${table}`);
  });
  mocks.createServiceRoleClient.mockReturnValue({ from, rpc });
  mocks.send.mockResolvedValue({ data: { id: "mock-email-receipt" }, error: null });
  return { from, rpc, bookingQuery };
}

async function render(event: OwnerNotificationEvent = "cancel", targetBookingId = bookingId) {
  await sendOwnerBookingNotification({ salonId, bookingId: targetBookingId, event, eventOccurrenceKey: occurrence });
  expect(mocks.send).toHaveBeenCalledOnce();
  return mocks.send.mock.calls[0][0] as { html: string; text: string; to: string };
}

describe("owner cancellation email shortcut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://qa.example.com");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the exact booking review link and explicit confirmation notice in HTML and text", async () => {
    const h = setup();
    const message = await render();
    const url = `https://qa.example.com/dashboard/e2e-email-fee/cancellation-fee/${bookingId}`;
    expect(message.html).toContain(`href="${url}"`);
    expect(message.text).toContain(url);
    for (const body of [message.html, message.text]) {
      expect(body).toContain("Review cancellation fee · Xử lý phí hủy");
      expect(body).toContain("Opening this link does not charge the customer.");
      expect(body).toContain("Hãy kiểm tra phí và xác nhận trước khi thu.");
      expect(body).not.toContain("token=");
      expect(body).not.toContain("Collect $");
    }
    expect(message.to).toBe("owner@example.com");
    expect(h.bookingQuery.eq).toHaveBeenCalledWith("salon_id", salonId);
    expect(h.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_owner_booking_notification", "complete_owner_booking_notification",
    ]);
  });

  it("encodes both route segments so supplied characters cannot inject a query or HTML attribute", async () => {
    setup({ slug: 'e2e/other?next="&tenant=elsewhere' });
    const target = 'booking/other?charge=true"&x=<tag>';
    const message = await render("cancel", target);
    const url = `https://qa.example.com/dashboard/${encodeURIComponent('e2e/other?next="&tenant=elsewhere')}/cancellation-fee/${encodeURIComponent(target)}`;
    expect(message.html).toContain(`href="${url}"`);
    expect(message.text).toContain(url);
    expect(message.html).not.toContain('href="https://qa.example.com/dashboard/e2e/other?next=');
  });

  it.each<OwnerNotificationEvent>(["new", "reschedule", "no_show"])("preserves the dashboard CTA for %s", async (event) => {
    setup();
    const message = await render(event);
    expect(message.html).toContain('href="https://qa.example.com/dashboard/e2e-email-fee"');
    expect(message.text).toContain("Open dashboard: https://qa.example.com/dashboard/e2e-email-fee");
    expect(message.html).not.toContain("/cancellation-fee/");
    expect(message.text).not.toContain("Opening this link");
  });

  it("does not claim a review destination when the salon has no slug", async () => {
    setup({ slug: "" });
    const message = await render();
    expect(message.text).toContain("Open dashboard: https://qa.example.com");
    expect(message.html).not.toContain("Review cancellation fee");
  });

  it.each([{ enabled: false }, { cancelEnabled: false }, { status: "confirmed" }])("preserves notification opt-outs and booking-state guards: %j", async (options) => {
    setup(options);
    const result = await sendOwnerBookingNotification({ salonId, bookingId, event: "cancel", eventOccurrenceKey: occurrence });
    expect(result.outcome).toBe("suppressed");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("preserves durable duplicate suppression", async () => {
    setup({ duplicate: true });
    const result = await sendOwnerBookingNotification({ salonId, bookingId, event: "cancel", eventOccurrenceKey: occurrence });
    expect(result.outcome).toBe("sent");
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

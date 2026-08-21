import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  inspect: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  reschedule: vi.fn(),
  charge: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(),
  after: vi.fn(),
}));
vi.mock("@/shared/security/sameOriginMutation", () => ({ isSameOriginMutation: () => true }));
vi.mock("@/shared/booking/bookingManagementRateLimit", () => ({
  consumeBookingManagementRateLimit: mocks.rate,
}));
vi.mock("@/shared/booking/bookingManagementCapabilities", () => ({
  inspectBookingManagementCapability: mocks.inspect,
  confirmBookingWithManagementCapability: mocks.confirm,
  cancelBookingWithManagementCapability: mocks.cancel,
  rescheduleBookingWithManagementCapability: mocks.reschedule,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/shared/integrations/square/noshow", () => ({ chargeNoShowFee: mocks.charge }));
vi.mock("@/shared/dashboard/reconcilePublicBookingManagementAudit", () => ({
  reconcilePublicBookingManagementAudit: vi.fn(),
}));
vi.mock("@/shared/dashboard/sendOwnerBookingNotification", () => ({
  sendOwnerBookingNotification: vi.fn(),
}));
vi.mock("@/shared/noshow/deliverPromotedWaitlistOffer", () => ({
  deliverPromotedWaitlistOffer: vi.fn(),
}));
vi.mock("@/shared/notifications/customerBookingTransitionEmail", () => ({
  deliverCustomerBookingTransitionEmail: vi.fn(),
}));

import { POST as confirmPost } from "@/app/api/booking/confirm-action/route";
import { POST as cancelPost } from "@/app/api/booking/cancel-action/route";
import { POST as reschedulePost } from "@/app/api/booking/reschedule-action/route";
import { POST as removeCardPost } from "@/app/api/booking/remove-card/route";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const base = {
  token: TOKEN,
  requestId: REQUEST_ID,
  expectedCardFingerprint: "a".repeat(64),
  date: "2099-08-20",
  slotLabel: "10:00 AM",
  newStartUtc: "2099-08-20T17:00:00.000Z",
  newEndUtc: "2099-08-20T18:00:00.000Z",
};

type Handler = (request: Request) => Promise<Response>;
const routes: Array<[string, Handler, number]> = [
  ["confirm", confirmPost, 1024],
  ["cancel", cancelPost, 1024],
  ["reschedule", reschedulePost, 2048],
  ["remove-card", removeCardPost, 1024],
];

function request(pathname: string, body: Record<string, unknown>, contentLength?: string) {
  const encoded = JSON.stringify(body);
  const headers: Record<string, string> = {
    Origin: "https://nailiq.test",
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
  };
  if (contentLength !== undefined) headers["Content-Length"] = contentLength;
  return new Request(`https://nailiq.test/api/booking/${pathname}-action`, {
    method: "POST",
    headers,
    body: encoded,
  });
}

describe("booking-management actual stream bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspect.mockResolvedValue({ ok: false, code: "token_consumed" });
    mocks.confirm.mockResolvedValue({ ok: false, code: "management_unavailable" });
    mocks.cancel.mockResolvedValue({ ok: false, code: "management_unavailable" });
    mocks.reschedule.mockResolvedValue({ ok: false, code: "management_unavailable" });
  });

  it.each(routes)("%s accepts a bounded body without Content-Length and reaches the durable limiter", async (name, handler) => {
    mocks.rate.mockResolvedValue("limited");
    const response = await handler(request(name, base));
    expect(response.status).toBe(429);
    expect(mocks.rate).toHaveBeenCalledTimes(1);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it.each(routes)("%s rejects an oversized actual stream despite a spoofed small Content-Length", async (name, handler, limit) => {
    mocks.rate.mockResolvedValue("allowed");
    const response = await handler(request(name, { ...base, padding: "x".repeat(limit + 100) }, "100"));
    expect(response.status).toBe(400);
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.reschedule).not.toHaveBeenCalled();
    expect(mocks.charge).not.toHaveBeenCalled();
  });
});

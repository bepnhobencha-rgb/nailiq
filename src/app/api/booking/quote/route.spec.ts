import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const rpc = vi.fn();
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc }),
}));

import { NextRequest } from "next/server";
import { POST } from "./route";

const body = {
  salonId: "11111111-1111-4111-8111-111111111111",
  serviceId: "22222222-2222-4222-8222-222222222222",
  resolvedStaffId: "33333333-3333-4333-8333-333333333333",
  resolvedStaffName: "Mai",
  startTimeUtc: "2026-08-21T17:00:00.000Z",
  endTimeUtc: "2026-08-21T18:00:00.000Z",
  addonServiceIds: [],
  comboId: null,
  voucherCode: null,
  clientPhone: "16045551234",
  clientEmail: null,
  applyEmailDiscount: false,
};

function request(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/booking/quote", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/booking/quote boundary", () => {
  beforeEach(() => rpc.mockReset());

  it("denies a request with no Origin before touching the database", async () => {
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("denies a cross-origin request before touching the database", async () => {
    const response = await POST(request({ origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when the database rate limiter is unavailable", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    const response = await POST(request({ origin: "http://localhost" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: "quote_unavailable" });
  });

  it("accepts the configured Vercel preview origin, then still fails closed", async () => {
    const previous = process.env.VERCEL_URL;
    process.env.VERCEL_URL = "nailiq-preview.vercel.app";
    rpc.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    try {
      const response = await POST(request({ origin: "https://nailiq-preview.vercel.app" }));
      expect(response.status).toBe(503);
      expect(rpc).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.VERCEL_URL;
      else process.env.VERCEL_URL = previous;
    }
  });
});

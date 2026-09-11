import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const { limit, auth } = vi.hoisted(() => ({ limit: vi.fn(), auth: vi.fn() }));
vi.mock("@/shared/security/edgeDurableRateLimit", () => ({ consumeEdgeDurableRateLimits: limit }));
vi.mock("@supabase/ssr", () => ({ createServerClient: auth }));
vi.mock("@/shared/lib/customDomainResolver", () => ({ isPlatformHost: () => true, resolveCustomDomainSlug: vi.fn() }));
vi.mock("@/shared/lib/rateLimit", () => ({ checkAuthRateLimit: () => false, checkBookingPageRateLimit: () => false, checkBookingRateLimit: () => false }));
import { proxy } from "@/proxy";

describe("booking API failure before route dispatch", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, "warn").mockImplementation(() => {}); limit.mockResolvedValue("unavailable"); });
  afterEach(() => vi.restoreAllMocks());
  it.each([
    ["group-quote", "quote_unavailable"], ["save-card-context", "management_unavailable"],
  ])("keeps %s failures machine-readable, private and fail-closed", async (route, code) => {
    const response = await proxy(new NextRequest(`https://www.nailiq.ca/api/booking/${route}?token=private-token`));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("retry-after")).toBe("30");
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "booking_proxy_unavailable", stage: "public_api_metering", status: 503, code }));
    expect(auth).not.toHaveBeenCalled();
  });
});

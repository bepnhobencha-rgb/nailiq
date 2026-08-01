import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertPresence = vi.hoisted(() => vi.fn());
vi.mock("@/shared/dashboard/presenceActions", () => ({
  upsertPresence,
}));

import { POST } from "@/app/api/dashboard/presence/route";

const SALON_ID = "11111111-1111-4111-8111-111111111111";

function request(
  body: Record<string, unknown>,
  origin = "https://nailiq.ca",
) {
  return new NextRequest("https://nailiq.ca/api/dashboard/presence", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "User-Agent": "NailIQ test browser",
    },
    body: JSON.stringify(body),
  });
}

describe("presence API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertPresence.mockResolvedValue({ ok: true });
  });

  it("rejects cross-origin heartbeats before mutation", async () => {
    const response = await POST(
      request(
        {
          salonId: SALON_ID,
          currentPath: "/dashboard/hoa-hong/ai",
          batteryLevel: 80,
        },
        "https://attacker.example",
      ),
    );
    expect(response.status).toBe(403);
    expect(upsertPresence).not.toHaveBeenCalled();
  });

  it("validates bounded browser telemetry", async () => {
    const response = await POST(
      request({
        salonId: SALON_ID,
        currentPath: "/dashboard/hoa-hong/ai",
        batteryLevel: 101,
      }),
    );
    expect(response.status).toBe(400);
    expect(upsertPresence).not.toHaveBeenCalled();
  });

  it("derives user agent from the request and delegates auth to the action", async () => {
    const response = await POST(
      request({
        salonId: SALON_ID,
        currentPath: "/dashboard/hoa-hong/ai",
        batteryLevel: null,
      }),
    );
    expect(response.status).toBe(200);
    expect(upsertPresence).toHaveBeenCalledWith({
      salonId: SALON_ID,
      currentPath: "/dashboard/hoa-hong/ai",
      batteryLevel: null,
      userAgent: "NailIQ test browser",
    });
  });
});

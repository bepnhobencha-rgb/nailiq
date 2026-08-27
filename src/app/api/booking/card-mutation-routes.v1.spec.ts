import { beforeEach, describe, expect, it, vi } from "vitest";

const { consumeRateLimit, saveCard, createStripeSetup } = vi.hoisted(() => ({
  consumeRateLimit: vi.fn(),
  saveCard: vi.fn(),
  createStripeSetup: vi.fn(),
}));

vi.mock("@/shared/security/sameOriginMutation", () => ({
  isSameOriginMutation: () => true,
}));

vi.mock("@/shared/booking/bookingManagementRateLimit", () => ({
  consumeBookingManagementRateLimit: consumeRateLimit,
}));

vi.mock("@/shared/booking/bookingCardManagement", () => ({
  saveCardWithManagementCapability: saveCard,
  createStripeSetupWithManagementCapability: createStripeSetup,
}));

import { POST as saveSquareCard } from "@/app/api/booking/square-save-card/route";
import { POST as createStripeSetupIntent } from "@/app/api/booking/stripe-setup-intent/route";

function jsonRequest(pathname: string, body: Record<string, unknown>): Request {
  return new Request(`https://nailiq.test${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("V1 card mutation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeRateLimit.mockResolvedValue("allowed");
    saveCard.mockResolvedValue({ ok: true, code: "saved" });
  });

  it("allows only the narrow Square card-on-file mutation", async () => {
    const response = await saveSquareCard(
      jsonRequest("/api/booking/square-save-card", {
        token: "11111111-1111-4111-8111-111111111111",
        requestId: "22222222-2222-4222-8222-222222222222",
        sourceId: "provider-source-token",
        provider: "square",
        consent: true,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      code: "saved",
    });
    expect(consumeRateLimit).toHaveBeenCalledOnce();
    expect(saveCard).toHaveBeenCalledOnce();
  });

  it("rejects a stale Stripe capability before rate, database, or provider work", async () => {
    const response = await createStripeSetupIntent(
      jsonRequest("/api/booking/stripe-setup-intent", {
        token: "11111111-1111-4111-8111-111111111111",
        requestId: "22222222-2222-4222-8222-222222222222",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "phase_2_not_available",
    });
    expect(consumeRateLimit).not.toHaveBeenCalled();
    expect(createStripeSetup).not.toHaveBeenCalled();
  });
});

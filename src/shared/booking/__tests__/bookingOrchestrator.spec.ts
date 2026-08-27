import { describe, expect, it, vi } from "vitest";

import {
  BOOKING_GATEWAY_POLICY,
  BookingOrchestratorPolicyError,
  bookingChannelFor,
  resolveBookingOrchestratorRoute,
  runBookingOrchestrator,
} from "@/shared/booking/bookingOrchestrator";

describe("booking orchestrator", () => {
  it.each([
    ["online", "individual", "commit", "online", "canonical_individual"],
    ["online", "group", "quote", "online", "canonical_group"],
    ["desk", "individual", "commit", "desk", "canonical_individual"],
    ["desk", "group", "commit", "desk", "canonical_group"],
    ["voice", "individual", "commit", "voice", "canonical_individual"],
    ["voice", "group", "commit", "voice", "canonical_group"],
    ["walkin", "operational_arrival", "commit", "walkin", "operational_queue"],
    ["wix", "external_import", "reconcile", "wix", "provider_reconciliation"],
    ["square", "external_import", "reconcile", "square", "provider_reconciliation"],
    ["chat", "assist", "assist", null, "assist_only"],
  ] as const)(
    "routes %s/%s through %s",
    (gateway, intent, operation, channel, engine) => {
      expect(resolveBookingOrchestratorRoute({ gateway, intent, operation })).toEqual({
        gateway,
        intent,
        operation,
        channel,
        engine,
      });
    },
  );

  it("keeps the persisted booking-channel vocabulary centralized", () => {
    expect(Object.values(BOOKING_GATEWAY_POLICY).map((policy) => policy.channel)).toEqual([
      "online",
      "desk",
      "voice",
      "walkin",
      "wix",
      "square",
      null,
    ]);
  });

  it("returns a gateway-narrowed durable channel", () => {
    expect(bookingChannelFor({
      gateway: "voice",
      intent: "individual",
      operation: "commit",
    })).toBe("voice");
  });

  it.each([
    { gateway: "chat", intent: "individual", operation: "commit" },
    { gateway: "wix", intent: "individual", operation: "commit" },
    { gateway: "square", intent: "external_import", operation: "commit" },
    { gateway: "walkin", intent: "operational_arrival", operation: "quote" },
    { gateway: "online", intent: "individual", operation: "assist" },
  ] as const)("rejects an invalid route: $gateway/$intent/$operation", (request) => {
    expect(() => resolveBookingOrchestratorRoute(request)).toThrow(
      BookingOrchestratorPolicyError,
    );
  });

  it("does not execute a forbidden gateway callback", async () => {
    const execute = vi.fn();
    await expect(
      runBookingOrchestrator(
        { gateway: "chat", intent: "group", operation: "commit" },
        execute,
      ),
    ).rejects.toMatchObject({ code: "gateway_intent_forbidden" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns the canonical engine result without translating it", async () => {
    const committed = {
      bookingId: "booking-1",
      cardManagementPending: true,
    };
    const result = await runBookingOrchestrator(
      { gateway: "online", intent: "individual", operation: "commit" },
      (route) => {
        expect(route.engine).toBe("canonical_individual");
        return committed;
      },
    );
    expect(result).toBe(committed);
  });
});

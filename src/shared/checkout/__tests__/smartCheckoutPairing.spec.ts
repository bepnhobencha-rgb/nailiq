import { describe, expect, it, vi } from "vitest";

import {
  createSquareSandboxPairingAdapter,
  createStripeSandboxPairingAdapter,
} from "@/shared/checkout/smartCheckoutPairing";

const gate = { environment: "sandbox", sandboxPairingEnabled: true } as const;
const common = {
  providerAccountId: "acct_qa",
  providerLocationId: "loc_qa",
  label: "Front desk",
  idempotencyKey: "pair-attempt-1",
};

describe("Smart Checkout device pairing", () => {
  it("creates and retrieves the same Square device code without inventing a device", async () => {
    const createDeviceCode = vi.fn(async () => ({
      id: "code_qa",
      code: "PAIR12",
      status: "UNPAIRED",
      deviceId: null,
      locationId: "loc_qa",
      expiresAt: "2026-09-01T00:00:00Z",
    }));
    const retrieveDeviceCode = vi.fn(async () => ({
      id: "code_qa",
      code: null,
      status: "PAIRED",
      deviceId: "device_qa",
      locationId: "loc_qa",
      expiresAt: "2026-09-01T00:00:00Z",
    }));
    const adapter = createSquareSandboxPairingAdapter({
      gate,
      transport: { createDeviceCode, retrieveDeviceCode },
    });

    await expect(adapter.startPairing(common)).resolves.toMatchObject({
      providerPairingId: "code_qa",
      providerDeviceId: null,
      pairingCode: "PAIR12",
      status: "pending_customer",
    });
    await expect(adapter.retrievePairing({
      providerAccountId: "acct_qa",
      providerLocationId: "loc_qa",
      providerPairingId: "code_qa",
    })).resolves.toMatchObject({
      providerPairingId: "code_qa",
      providerDeviceId: "device_qa",
      pairingCode: null,
      status: "paired",
    });
  });

  it("uses a Stripe registration code once and never returns it", async () => {
    const registerReader = vi.fn(async () => ({
      id: "tmr_qa",
      status: "offline",
      locationId: "loc_qa",
    }));
    const adapter = createStripeSandboxPairingAdapter({
      gate,
      transport: {
        registerReader,
        retrieveReader: vi.fn(async () => ({
          id: "tmr_qa", status: "online", locationId: "loc_qa",
        })),
      },
    });

    const result = await adapter.startPairing({ ...common, registrationCode: "waves-quietly" });
    expect(registerReader).toHaveBeenCalledWith(expect.objectContaining({
      registrationCode: "waves-quietly",
    }));
    expect(JSON.stringify(result)).not.toContain("waves-quietly");
    expect(result).toMatchObject({ providerDeviceId: "tmr_qa", status: "paired" });
  });

  it("fails before transport outside the explicit sandbox gate", async () => {
    const createDeviceCode = vi.fn();
    const adapter = createSquareSandboxPairingAdapter({
      gate: { environment: "production", sandboxPairingEnabled: true },
      transport: { createDeviceCode, retrieveDeviceCode: vi.fn() },
    });
    await expect(adapter.startPairing(common)).rejects.toMatchObject({
      code: "smart_checkout_sandbox_only",
    });
    expect(createDeviceCode).not.toHaveBeenCalled();
  });

  it("redacts a thrown provider body to one safe code", async () => {
    const adapter = createStripeSandboxPairingAdapter({
      gate,
      transport: {
        registerReader: vi.fn(async () => {
          throw new Error("sk_test_secret raw provider body");
        }),
        retrieveReader: vi.fn(),
      },
    });
    const error = await adapter.startPairing({
      ...common,
      registrationCode: "waves-quietly",
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "smart_checkout_transport_outcome_unknown" });
    expect(String(error)).not.toContain("sk_test_secret");
  });
});

import type { SmartCheckoutProvider } from "@/shared/checkout/smartCheckout";
import {
  SmartCheckoutSandboxAdapterError,
} from "@/shared/checkout/smartCheckoutSandboxAdapters";

export type SmartCheckoutPairingRuntimeGate = {
  environment: "sandbox" | "production";
  sandboxPairingEnabled: boolean;
};

function assertPairingEnabled(gate: SmartCheckoutPairingRuntimeGate): void {
  if (gate.environment !== "sandbox") {
    throw new SmartCheckoutSandboxAdapterError("smart_checkout_sandbox_only");
  }
  if (!gate.sandboxPairingEnabled) {
    throw new SmartCheckoutSandboxAdapterError("smart_checkout_sandbox_disabled");
  }
}

export type SmartCheckoutPairingStatus =
  | "pending_customer"
  | "paired"
  | "expired"
  | "failed"
  | "outcome_unknown";

export type SmartCheckoutPairingReceipt = {
  provider: SmartCheckoutProvider;
  providerPairingId: string;
  providerDeviceId: string | null;
  providerLocationId: string;
  status: SmartCheckoutPairingStatus;
  providerStatus: string;
  pairingCode: string | null;
  expiresAt: string | null;
};

export type SmartCheckoutPairingStartInput = {
  providerAccountId: string;
  providerLocationId: string;
  label: string;
  idempotencyKey: string;
  /** Stripe reader registration code. It is used once and never returned. */
  registrationCode?: string;
};

export type SmartCheckoutPairingRetrieveInput = {
  providerAccountId: string;
  providerLocationId: string;
  providerPairingId: string;
};

export interface SmartCheckoutPairingAdapter {
  readonly provider: SmartCheckoutProvider;
  startPairing(input: SmartCheckoutPairingStartInput): Promise<SmartCheckoutPairingReceipt>;
  retrievePairing(input: SmartCheckoutPairingRetrieveInput): Promise<SmartCheckoutPairingReceipt>;
}

export type SquareSandboxDeviceCode = {
  id: string;
  code: string | null;
  status: string;
  deviceId: string | null;
  locationId: string;
  expiresAt: string | null;
};

export interface SquareSandboxPairingTransport {
  createDeviceCode(input: {
    providerAccountId: string;
    providerLocationId: string;
    label: string;
    idempotencyKey: string;
  }): Promise<SquareSandboxDeviceCode>;
  retrieveDeviceCode(input: {
    providerAccountId: string;
    providerLocationId: string;
    providerPairingId: string;
  }): Promise<SquareSandboxDeviceCode>;
}

export type StripeSandboxReader = {
  id: string;
  status: string;
  locationId: string;
};

export interface StripeSandboxPairingTransport {
  registerReader(input: {
    providerAccountId: string;
    providerLocationId: string;
    registrationCode: string;
    label: string;
    idempotencyKey: string;
  }): Promise<StripeSandboxReader>;
  retrieveReader(input: {
    providerAccountId: string;
    providerLocationId: string;
    providerPairingId: string;
  }): Promise<StripeSandboxReader>;
}

const SAFE_ID = /^[!-~]{1,255}$/u;

function required(value: string | undefined, code = "smart_checkout_transport_invalid_response") {
  const normalized = value?.trim() ?? "";
  if (!SAFE_ID.test(normalized)) throw new SmartCheckoutSandboxAdapterError(code as never);
  return normalized;
}

function label(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 100) {
    throw new SmartCheckoutSandboxAdapterError("smart_checkout_transport_invalid_response");
  }
  return normalized;
}

function squareReceipt(value: SquareSandboxDeviceCode): SmartCheckoutPairingReceipt {
  const providerPairingId = required(value.id);
  const providerLocationId = required(value.locationId);
  const providerStatus = required(value.status).toUpperCase();
  const providerDeviceId = value.deviceId ? required(value.deviceId) : null;
  const pairingCode = value.code?.trim() || null;
  let status: SmartCheckoutPairingStatus;
  if (providerStatus === "PAIRED") status = providerDeviceId ? "paired" : "outcome_unknown";
  else if (providerStatus === "UNPAIRED") status = pairingCode ? "pending_customer" : "outcome_unknown";
  else if (providerStatus === "EXPIRED") status = "expired";
  else status = "outcome_unknown";
  return {
    provider: "square",
    providerPairingId,
    providerDeviceId,
    providerLocationId,
    status,
    providerStatus,
    pairingCode: status === "pending_customer" ? pairingCode : null,
    expiresAt: value.expiresAt,
  };
}

function stripeReceipt(value: StripeSandboxReader): SmartCheckoutPairingReceipt {
  const providerDeviceId = required(value.id);
  const providerLocationId = required(value.locationId);
  const providerStatus = required(value.status).toLowerCase();
  return {
    provider: "stripe",
    providerPairingId: providerDeviceId,
    providerDeviceId,
    providerLocationId,
    status: "paired",
    providerStatus,
    pairingCode: null,
    expiresAt: null,
  };
}

function safeTransportFailure(): never {
  throw new SmartCheckoutSandboxAdapterError("smart_checkout_transport_outcome_unknown");
}

export function createSquareSandboxPairingAdapter(input: {
  gate: SmartCheckoutPairingRuntimeGate;
  transport: SquareSandboxPairingTransport;
}): SmartCheckoutPairingAdapter {
  const enabled = () => assertPairingEnabled(input.gate);
  return {
    provider: "square",
    async startPairing(request) {
      enabled();
      try {
        return squareReceipt(await input.transport.createDeviceCode({
          providerAccountId: required(request.providerAccountId),
          providerLocationId: required(request.providerLocationId),
          label: label(request.label),
          idempotencyKey: required(request.idempotencyKey),
        }));
      } catch (error) {
        if (error instanceof SmartCheckoutSandboxAdapterError) throw error;
        return safeTransportFailure();
      }
    },
    async retrievePairing(request) {
      enabled();
      try {
        return squareReceipt(await input.transport.retrieveDeviceCode({
          providerAccountId: required(request.providerAccountId),
          providerLocationId: required(request.providerLocationId),
          providerPairingId: required(request.providerPairingId),
        }));
      } catch (error) {
        if (error instanceof SmartCheckoutSandboxAdapterError) throw error;
        return safeTransportFailure();
      }
    },
  };
}

export function createStripeSandboxPairingAdapter(input: {
  gate: SmartCheckoutPairingRuntimeGate;
  transport: StripeSandboxPairingTransport;
}): SmartCheckoutPairingAdapter {
  const enabled = () => assertPairingEnabled(input.gate);
  return {
    provider: "stripe",
    async startPairing(request) {
      enabled();
      try {
        return stripeReceipt(await input.transport.registerReader({
          providerAccountId: required(request.providerAccountId),
          providerLocationId: required(request.providerLocationId),
          registrationCode: required(request.registrationCode),
          label: label(request.label),
          idempotencyKey: required(request.idempotencyKey),
        }));
      } catch (error) {
        if (error instanceof SmartCheckoutSandboxAdapterError) throw error;
        return safeTransportFailure();
      }
    },
    async retrievePairing(request) {
      enabled();
      try {
        return stripeReceipt(await input.transport.retrieveReader({
          providerAccountId: required(request.providerAccountId),
          providerLocationId: required(request.providerLocationId),
          providerPairingId: required(request.providerPairingId),
        }));
      } catch (error) {
        if (error instanceof SmartCheckoutSandboxAdapterError) throw error;
        return safeTransportFailure();
      }
    },
  };
}

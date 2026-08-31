import type {
  SmartCheckoutAdapter,
  SmartCheckoutCancelInput,
  SmartCheckoutDispatchInput,
  SmartCheckoutProviderReceipt,
  SmartCheckoutRetrieveInput,
} from "@/shared/checkout/smartCheckoutAdapter";
import {
  buildSquareTerminalCheckoutRequest,
  buildStripeTerminalPaymentIntentRequest,
  type SquareTerminalCheckoutRequest,
  type StripeTerminalPaymentIntentRequest,
} from "@/shared/checkout/smartCheckoutProviderMapping";

export type SmartCheckoutSandboxRuntimeGate = {
  environment: "sandbox" | "production";
  sandboxDispatchEnabled: boolean;
  sandboxProviderReadsEnabled: boolean;
};

export type SmartCheckoutSandboxAdapterErrorCode =
  | "smart_checkout_sandbox_disabled"
  | "smart_checkout_sandbox_only"
  | "smart_checkout_provider_account_required"
  | "smart_checkout_provider_location_required"
  | "smart_checkout_transport_invalid_response"
  | "smart_checkout_transport_outcome_unknown";

/** Deliberately contains a safe code only: no provider body, token, or secret. */
export class SmartCheckoutSandboxAdapterError extends Error {
  readonly code: SmartCheckoutSandboxAdapterErrorCode;

  constructor(code: SmartCheckoutSandboxAdapterErrorCode) {
    super(code);
    this.name = "SmartCheckoutSandboxAdapterError";
    this.code = code;
  }
}

export function assertSmartCheckoutSandboxRuntimeGate(
  gate: SmartCheckoutSandboxRuntimeGate,
  capability: "dispatch" | "provider_read" = "dispatch",
): void {
  if (gate.environment !== "sandbox") {
    throw new SmartCheckoutSandboxAdapterError("smart_checkout_sandbox_only");
  }
  if (
    capability === "dispatch"
      ? gate.sandboxDispatchEnabled !== true
      : gate.sandboxProviderReadsEnabled !== true
  ) {
    throw new SmartCheckoutSandboxAdapterError("smart_checkout_sandbox_disabled");
  }
}

export type SmartCheckoutSandboxTransportResult<T> =
  | { kind: "response"; response: T }
  | {
      kind: "ambiguous";
      checkoutId: string;
      paymentId: string | null;
      providerStatus: string;
      evidence: SmartCheckoutProviderReceipt["evidence"];
    }
  | {
      kind: "rejected";
      checkoutId: string;
      paymentId: string | null;
      providerStatus: string;
      evidence: SmartCheckoutProviderReceipt["evidence"];
    };

export type SquareTerminalSandboxCheckout = {
  id: string;
  status: string;
  paymentIds: string[];
  amountCents: number | null;
  currency: string | null;
  providerAccountId: string | null;
  providerLocationId: string | null;
  providerDeviceId: string | null;
  occurredAt: string | null;
};

export interface SquareTerminalSandboxTransport {
  createTerminalCheckout(input: {
    providerAccountId: string;
    providerLocationId: string;
    request: SquareTerminalCheckoutRequest;
  }): Promise<SmartCheckoutSandboxTransportResult<SquareTerminalSandboxCheckout>>;
  retrieveTerminalCheckout(input: {
    providerAccountId: string;
    providerLocationId: string;
    checkoutId: string;
  }): Promise<SmartCheckoutSandboxTransportResult<SquareTerminalSandboxCheckout>>;
  cancelTerminalCheckout(input: {
    providerAccountId: string;
    providerLocationId: string;
    checkoutId: string;
    idempotencyKey: string;
  }): Promise<SmartCheckoutSandboxTransportResult<SquareTerminalSandboxCheckout>>;
}

export type StripeTerminalSandboxPaymentIntent = {
  id: string;
  status: string;
  latestChargeId: string | null;
  amountCents: number | null;
  currency: string | null;
  providerAccountId: string | null;
  providerLocationId: string | null;
  providerDeviceId: string | null;
  occurredAt: string | null;
};

export interface StripeTerminalSandboxTransport {
  createPaymentIntent(input: {
    providerAccountId: string;
    idempotencyKey: string;
    request: StripeTerminalPaymentIntentRequest;
  }): Promise<SmartCheckoutSandboxTransportResult<StripeTerminalSandboxPaymentIntent>>;
  processPaymentIntent(input: {
    providerAccountId: string;
    readerId: string;
    paymentIntentId: string;
    idempotencyKey: string;
  }): Promise<SmartCheckoutSandboxTransportResult<StripeTerminalSandboxPaymentIntent>>;
  retrievePaymentIntent(input: {
    providerAccountId: string;
    paymentIntentId: string;
  }): Promise<SmartCheckoutSandboxTransportResult<StripeTerminalSandboxPaymentIntent>>;
  cancelPaymentIntent(input: {
    providerAccountId: string;
    paymentIntentId: string;
    idempotencyKey: string;
  }): Promise<SmartCheckoutSandboxTransportResult<StripeTerminalSandboxPaymentIntent>>;
}

function required(value: string | null, code: SmartCheckoutSandboxAdapterErrorCode): string {
  const normalized = value?.trim();
  if (!normalized) throw new SmartCheckoutSandboxAdapterError(code);
  return normalized;
}

function validateProviderIdentity(value: string): string {
  return required(value, "smart_checkout_provider_account_required");
}

function receiptFromTransportFailure(
  provider: "square" | "stripe",
  result: Extract<SmartCheckoutSandboxTransportResult<never>, { kind: "ambiguous" | "rejected" }>,
): SmartCheckoutProviderReceipt {
  const checkoutId = result.checkoutId.trim();
  const providerStatus = result.providerStatus.trim();
  if (!checkoutId || !providerStatus) {
    throw new SmartCheckoutSandboxAdapterError("smart_checkout_transport_invalid_response");
  }
  return {
    provider,
    checkoutId,
    paymentId: result.paymentId?.trim() || null,
    providerStatus,
    evidence: normalizeEvidence(result.evidence),
    status: result.kind === "ambiguous" ? "outcome_unknown" : "failed",
  };
}

function normalizeEvidence(
  evidence: SmartCheckoutProviderReceipt["evidence"],
): SmartCheckoutProviderReceipt["evidence"] {
  return {
    amountCents:
      Number.isSafeInteger(evidence.amountCents) && (evidence.amountCents ?? -1) >= 0
        ? evidence.amountCents
        : null,
    currency: evidence.currency?.trim().toUpperCase() || null,
    providerAccountId: evidence.providerAccountId?.trim() || null,
    providerLocationId: evidence.providerLocationId?.trim() || null,
    providerDeviceId: evidence.providerDeviceId?.trim() || null,
    occurredAt:
      evidence.occurredAt && Number.isFinite(Date.parse(evidence.occurredAt))
        ? evidence.occurredAt
        : null,
  };
}

function hasAuthoritativeMoneyEvidence(
  evidence: SmartCheckoutProviderReceipt["evidence"],
): boolean {
  return evidence.amountCents !== null && /^[A-Z]{3}$/u.test(evidence.currency ?? "");
}

export function mapSquareTerminalSandboxStatus(
  checkout: SquareTerminalSandboxCheckout,
): SmartCheckoutProviderReceipt {
  const checkoutId = checkout.id.trim();
  const providerStatus = checkout.status.trim().toUpperCase();
  const paymentId = checkout.paymentIds.find((id) => id.trim())?.trim() ?? null;
  const evidence = normalizeEvidence({
    amountCents: checkout.amountCents,
    currency: checkout.currency,
    providerAccountId: checkout.providerAccountId,
    providerLocationId: checkout.providerLocationId,
    providerDeviceId: checkout.providerDeviceId,
    occurredAt: checkout.occurredAt,
  });
  if (!checkoutId || !providerStatus) {
    throw new SmartCheckoutSandboxAdapterError("smart_checkout_transport_invalid_response");
  }

  let status: SmartCheckoutProviderReceipt["status"];
  switch (providerStatus) {
    case "PENDING":
    case "IN_PROGRESS":
      status = "awaiting_customer";
      break;
    case "CANCEL_REQUESTED":
      status = "pending_provider";
      break;
    case "CANCELED":
      status = "cancelled";
      break;
    case "COMPLETED":
      status = paymentId && hasAuthoritativeMoneyEvidence(evidence) ? "paid" : "outcome_unknown";
      break;
    default:
      status = "outcome_unknown";
  }

  return { provider: "square", checkoutId, paymentId, providerStatus, evidence, status };
}

export function mapStripeTerminalSandboxStatus(
  paymentIntent: StripeTerminalSandboxPaymentIntent,
): SmartCheckoutProviderReceipt {
  const checkoutId = paymentIntent.id.trim();
  const providerStatus = paymentIntent.status.trim().toLowerCase();
  const paymentId = paymentIntent.latestChargeId?.trim() || null;
  const evidence = normalizeEvidence({
    amountCents: paymentIntent.amountCents,
    currency: paymentIntent.currency,
    providerAccountId: paymentIntent.providerAccountId,
    providerLocationId: paymentIntent.providerLocationId,
    providerDeviceId: paymentIntent.providerDeviceId,
    occurredAt: paymentIntent.occurredAt,
  });
  if (!checkoutId || !providerStatus) {
    throw new SmartCheckoutSandboxAdapterError("smart_checkout_transport_invalid_response");
  }

  let status: SmartCheckoutProviderReceipt["status"];
  switch (providerStatus) {
    case "requires_payment_method":
    case "requires_confirmation":
    case "requires_action":
      status = "awaiting_customer";
      break;
    case "processing":
    case "requires_capture":
      status = "pending_provider";
      break;
    case "canceled":
      status = "cancelled";
      break;
    case "succeeded":
      status = paymentId && hasAuthoritativeMoneyEvidence(evidence) ? "paid" : "outcome_unknown";
      break;
    default:
      status = "outcome_unknown";
  }

  return { provider: "stripe", checkoutId, paymentId, providerStatus, evidence, status };
}

async function runTransport<T>(
  operation: () => Promise<SmartCheckoutSandboxTransportResult<T>>,
  ambiguity?: Extract<SmartCheckoutSandboxTransportResult<T>, { kind: "ambiguous" }>,
): Promise<SmartCheckoutSandboxTransportResult<T>> {
  try {
    return await operation();
  } catch {
    // Never include the thrown provider body/message. When the caller already
    // has a checkout identifier, preserve it so reconciliation can retrieve
    // that same checkout rather than redispatching.
    if (ambiguity) return ambiguity;
    throw new SmartCheckoutSandboxAdapterError("smart_checkout_transport_outcome_unknown");
  }
}

function emptyEvidence(): SmartCheckoutProviderReceipt["evidence"] {
  return {
    amountCents: null,
    currency: null,
    providerAccountId: null,
    providerLocationId: null,
    providerDeviceId: null,
    occurredAt: null,
  };
}

function mapSquareResult(
  result: SmartCheckoutSandboxTransportResult<SquareTerminalSandboxCheckout>,
): SmartCheckoutProviderReceipt {
  return result.kind === "response"
    ? mapSquareTerminalSandboxStatus(result.response)
    : receiptFromTransportFailure("square", result);
}

function mapStripeResult(
  result: SmartCheckoutSandboxTransportResult<StripeTerminalSandboxPaymentIntent>,
): SmartCheckoutProviderReceipt {
  return result.kind === "response"
    ? mapStripeTerminalSandboxStatus(result.response)
    : receiptFromTransportFailure("stripe", result);
}

export function createSquareTerminalSandboxAdapter(input: {
  gate: SmartCheckoutSandboxRuntimeGate;
  transport: SquareTerminalSandboxTransport;
}): SmartCheckoutAdapter {
  const assertDispatchEnabled = () => assertSmartCheckoutSandboxRuntimeGate(input.gate);
  const assertReadEnabled = () => assertSmartCheckoutSandboxRuntimeGate(
    input.gate,
    "provider_read",
  );

  return {
    provider: "square",
    async createCheckout(dispatch) {
      assertDispatchEnabled();
      const providerAccountId = validateProviderIdentity(dispatch.providerAccountId);
      const providerLocationId = required(
        dispatch.providerLocationId,
        "smart_checkout_provider_location_required",
      );
      return mapSquareResult(await runTransport(() => input.transport.createTerminalCheckout({
        providerAccountId,
        providerLocationId,
        request: buildSquareTerminalCheckoutRequest(dispatch),
      })));
    },
    async retrieveCheckout(retrieve) {
      assertReadEnabled();
      const providerAccountId = validateProviderIdentity(retrieve.providerAccountId);
      const providerLocationId = required(
        retrieve.providerLocationId,
        "smart_checkout_provider_location_required",
      );
      const checkoutId = required(retrieve.checkoutId, "smart_checkout_transport_invalid_response");
      return mapSquareResult(await runTransport(
        () => input.transport.retrieveTerminalCheckout({
          providerAccountId,
          providerLocationId,
          checkoutId,
        }),
        {
          kind: "ambiguous",
          checkoutId,
          paymentId: null,
          providerStatus: "transport_response_lost",
          evidence: emptyEvidence(),
        },
      ));
    },
    async cancelCheckout(cancel) {
      assertDispatchEnabled();
      const providerAccountId = validateProviderIdentity(cancel.providerAccountId);
      const providerLocationId = required(
        cancel.providerLocationId,
        "smart_checkout_provider_location_required",
      );
      const checkoutId = required(cancel.checkoutId, "smart_checkout_transport_invalid_response");
      return mapSquareResult(await runTransport(
        () => input.transport.cancelTerminalCheckout({
          providerAccountId,
          providerLocationId,
          checkoutId,
          idempotencyKey: required(cancel.idempotencyKey, "smart_checkout_transport_invalid_response"),
        }),
        {
          kind: "ambiguous",
          checkoutId,
          paymentId: null,
          providerStatus: "transport_response_lost",
          evidence: emptyEvidence(),
        },
      ));
    },
  };
}

export function createStripeTerminalSandboxAdapter(input: {
  gate: SmartCheckoutSandboxRuntimeGate;
  transport: StripeTerminalSandboxTransport;
}): SmartCheckoutAdapter {
  const assertDispatchEnabled = () => assertSmartCheckoutSandboxRuntimeGate(input.gate);
  const assertReadEnabled = () => assertSmartCheckoutSandboxRuntimeGate(
    input.gate,
    "provider_read",
  );

  return {
    provider: "stripe",
    async createCheckout(dispatch) {
      assertDispatchEnabled();
      const providerAccountId = validateProviderIdentity(dispatch.providerAccountId);
      const readerId = required(dispatch.providerDeviceId, "smart_checkout_transport_invalid_response");
      const created = await runTransport(() => input.transport.createPaymentIntent({
        providerAccountId,
        idempotencyKey: dispatch.idempotencyKey,
        request: buildStripeTerminalPaymentIntentRequest(dispatch),
      }));
      if (created.kind !== "response") return mapStripeResult(created);

      const createdReceipt = mapStripeTerminalSandboxStatus(created.response);
      if (createdReceipt.providerStatus !== "requires_payment_method") return createdReceipt;

      return mapStripeResult(await runTransport(
        () => input.transport.processPaymentIntent({
          providerAccountId,
          readerId,
          paymentIntentId: createdReceipt.checkoutId,
          idempotencyKey: dispatch.idempotencyKey,
        }),
        {
          kind: "ambiguous",
          checkoutId: createdReceipt.checkoutId,
          paymentId: createdReceipt.paymentId,
          providerStatus: "transport_response_lost",
          evidence: createdReceipt.evidence,
        },
      ));
    },
    async retrieveCheckout(retrieve) {
      assertReadEnabled();
      const providerAccountId = validateProviderIdentity(retrieve.providerAccountId);
      const paymentIntentId = required(retrieve.checkoutId, "smart_checkout_transport_invalid_response");
      return mapStripeResult(await runTransport(
        () => input.transport.retrievePaymentIntent({ providerAccountId, paymentIntentId }),
        {
          kind: "ambiguous",
          checkoutId: paymentIntentId,
          paymentId: null,
          providerStatus: "transport_response_lost",
          evidence: emptyEvidence(),
        },
      ));
    },
    async cancelCheckout(cancel) {
      assertDispatchEnabled();
      const providerAccountId = validateProviderIdentity(cancel.providerAccountId);
      const paymentIntentId = required(cancel.checkoutId, "smart_checkout_transport_invalid_response");
      return mapStripeResult(await runTransport(
        () => input.transport.cancelPaymentIntent({
          providerAccountId,
          paymentIntentId,
          idempotencyKey: required(cancel.idempotencyKey, "smart_checkout_transport_invalid_response"),
        }),
        {
          kind: "ambiguous",
          checkoutId: paymentIntentId,
          paymentId: null,
          providerStatus: "transport_response_lost",
          evidence: emptyEvidence(),
        },
      ));
    },
  };
}

// Keep the exported adapter contract inputs discoverable for orchestration code.
export type { SmartCheckoutCancelInput, SmartCheckoutDispatchInput, SmartCheckoutRetrieveInput };

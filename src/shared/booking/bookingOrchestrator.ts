/**
 * One routing boundary for every surface that can create or reconcile a
 * booking-shaped record.
 *
 * The orchestrator deliberately does not replace the canonical booking
 * engines. Individual appointments, groups, operational queue arrivals and
 * provider imports have different invariants. It makes that distinction
 * explicit and prevents a gateway from silently choosing a different writer.
 *
 * Keep this module runtime-neutral: the public booking flow calls it from the
 * browser, while desk, Voice and provider integrations call it on the server.
 */

export const BOOKING_GATEWAY_POLICY = {
  online: {
    channel: "online",
    intents: ["individual", "group"],
  },
  desk: {
    channel: "desk",
    intents: ["individual", "group"],
  },
  voice: {
    channel: "voice",
    intents: ["individual", "group"],
  },
  walkin: {
    channel: "walkin",
    intents: ["operational_arrival"],
  },
  wix: {
    channel: "wix",
    intents: ["external_import"],
  },
  square: {
    channel: "square",
    intents: ["external_import"],
  },
  chat: {
    channel: null,
    intents: ["assist"],
  },
} as const;

export type BookingGateway = keyof typeof BOOKING_GATEWAY_POLICY;
export type BookingIntent =
  | "individual"
  | "group"
  | "operational_arrival"
  | "external_import"
  | "assist";
export type BookingOrchestratorOperation =
  | "quote"
  | "commit"
  | "reconcile"
  | "assist";
export type BookingChannel = Exclude<
  (typeof BOOKING_GATEWAY_POLICY)[BookingGateway]["channel"],
  null
>;
type PersistedBookingGateway = Exclude<BookingGateway, "chat">;
type GatewayBookingChannel<Gateway extends PersistedBookingGateway> = Exclude<
  (typeof BOOKING_GATEWAY_POLICY)[Gateway]["channel"],
  null
>;
export type BookingEngine =
  | "canonical_individual"
  | "canonical_group"
  | "operational_queue"
  | "provider_reconciliation"
  | "assist_only";

export type BookingOrchestratorRequest = {
  gateway: BookingGateway;
  intent: BookingIntent;
  operation: BookingOrchestratorOperation;
};

export type BookingOrchestratorRoute = BookingOrchestratorRequest & {
  channel: BookingChannel | null;
  engine: BookingEngine;
};

const ENGINE_BY_INTENT: Record<BookingIntent, BookingEngine> = {
  individual: "canonical_individual",
  group: "canonical_group",
  operational_arrival: "operational_queue",
  external_import: "provider_reconciliation",
  assist: "assist_only",
};

function operationAllowed(
  intent: BookingIntent,
  operation: BookingOrchestratorOperation,
): boolean {
  if (intent === "assist") return operation === "assist";
  if (operation === "assist") return false;
  if (operation === "quote") {
    return intent === "individual" || intent === "group";
  }
  if (operation === "reconcile") return intent === "external_import";
  return intent !== "external_import";
}

export class BookingOrchestratorPolicyError extends Error {
  constructor(public readonly code: "gateway_intent_forbidden" | "operation_forbidden") {
    super(code);
    this.name = "BookingOrchestratorPolicyError";
  }
}

export function resolveBookingOrchestratorRoute(
  request: BookingOrchestratorRequest,
): BookingOrchestratorRoute {
  const policy = BOOKING_GATEWAY_POLICY[request.gateway];
  const intents = policy.intents as readonly BookingIntent[];
  if (!intents.includes(request.intent)) {
    throw new BookingOrchestratorPolicyError("gateway_intent_forbidden");
  }
  if (!operationAllowed(request.intent, request.operation)) {
    throw new BookingOrchestratorPolicyError("operation_forbidden");
  }
  return {
    ...request,
    channel: policy.channel,
    engine: ENGINE_BY_INTENT[request.intent],
  };
}

export function bookingChannelFor<Gateway extends PersistedBookingGateway>(
  request: BookingOrchestratorRequest & { gateway: Gateway },
): GatewayBookingChannel<Gateway> {
  const route = resolveBookingOrchestratorRoute(request);
  if (route.channel === null) {
    throw new BookingOrchestratorPolicyError("operation_forbidden");
  }
  return route.channel as GatewayBookingChannel<Gateway>;
}

/**
 * Executes one gateway operation only after the central routing policy accepts
 * it. The callback receives the resolved channel and canonical engine; adapters
 * that stamp a durable row use `bookingChannelFor` instead of string literals.
 *
 * Errors and return values are intentionally transparent. In particular, this
 * boundary must never translate a committed booking into failure; the
 * canonical engine owns its durable receipt and post-commit reconciliation.
 */
export async function runBookingOrchestrator<T>(
  request: BookingOrchestratorRequest,
  execute: (route: BookingOrchestratorRoute) => Promise<T> | T,
): Promise<T> {
  const route = resolveBookingOrchestratorRoute(request);
  return execute(route);
}

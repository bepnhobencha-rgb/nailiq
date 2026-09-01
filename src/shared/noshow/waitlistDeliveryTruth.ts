export type WaitlistDeliveryChannel = "sms" | "email";

export type WaitlistDeliveryStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "unknown"
  | "suppressed"
  | "unavailable";

export type WaitlistDeliveryReason =
  | "channel_disabled"
  | "recipient_missing"
  | "recipient_suppressed"
  | "provider_rejected"
  | "outcome_unknown"
  | null;

export type WaitlistChannelDeliveryTruth = {
  status: WaitlistDeliveryStatus;
  reason: WaitlistDeliveryReason;
  updatedAt: string | null;
};

export type WaitlistDeliveryTruth = {
  offerEpoch: number | null;
  sms: WaitlistChannelDeliveryTruth;
  email: WaitlistChannelDeliveryTruth;
};

export type WaitlistDeliveryTruthRow = {
  waitlist_entry_id: unknown;
  offer_epoch: unknown;
  channel: unknown;
  status: unknown;
  error_code: unknown;
  updated_at: unknown;
};

const DELIVERY_STATUSES = new Set<WaitlistDeliveryStatus>([
  "pending",
  "sending",
  "sent",
  "failed",
  "unknown",
  "suppressed",
]);

function unavailableChannel(): WaitlistChannelDeliveryTruth {
  return { status: "unavailable", reason: null, updatedAt: null };
}

export function emptyWaitlistDeliveryTruth(
  offerEpoch: number | null = null,
): WaitlistDeliveryTruth {
  return {
    offerEpoch,
    sms: unavailableChannel(),
    email: unavailableChannel(),
  };
}

function safeStatus(value: unknown): WaitlistDeliveryStatus | null {
  return typeof value === "string" &&
    DELIVERY_STATUSES.has(value as WaitlistDeliveryStatus)
    ? (value as WaitlistDeliveryStatus)
    : null;
}

function safeUpdatedAt(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return value;
}

function safeReason(
  status: WaitlistDeliveryStatus,
  value: unknown,
): WaitlistDeliveryReason {
  if (status === "unknown") return "outcome_unknown";
  if (typeof value !== "string") return null;
  if (value === "channel_disabled") return "channel_disabled";
  if (value === "recipient_missing") return "recipient_missing";
  if (
    value === "provider_stop" ||
    value === "recipient_suppressed" ||
    value === "email_opt_out"
  ) {
    return "recipient_suppressed";
  }
  if (
    value === "provider_rejected" ||
    value === "provider_configuration_invalid"
  ) {
    return "provider_rejected";
  }
  if (
    value === "invalid_provider_receipt" ||
    value === "provider_exception" ||
    value.includes("ambiguous")
  ) {
    return "outcome_unknown";
  }
  return null;
}

/**
 * Reduces privileged outbox rows to receptionist-safe delivery truth.
 * Callers supply the authoritative current offer epoch for each entry so an
 * old failed attempt can never repaint a newer successful invitation.
 */
export function summarizeWaitlistDeliveryTruth(
  entryEpochs: ReadonlyMap<string, number>,
  rows: readonly WaitlistDeliveryTruthRow[],
): Map<string, WaitlistDeliveryTruth> {
  const truthByEntry = new Map<string, WaitlistDeliveryTruth>();
  for (const [entryId, epoch] of entryEpochs) {
    truthByEntry.set(entryId, emptyWaitlistDeliveryTruth(epoch));
  }

  for (const row of rows) {
    const entryId =
      typeof row.waitlist_entry_id === "string"
        ? row.waitlist_entry_id.trim()
        : "";
    const expectedEpoch = truthByEntry.get(entryId)?.offerEpoch;
    const epoch = row.offer_epoch;
    const channel = row.channel;
    const status = safeStatus(row.status);
    if (
      !entryId ||
      typeof epoch !== "number" ||
      !Number.isSafeInteger(epoch) ||
      epoch !== expectedEpoch ||
      (channel !== "sms" && channel !== "email") ||
      !status
    ) {
      continue;
    }

    const current = truthByEntry.get(entryId);
    if (!current) continue;
    current[channel] = {
      status,
      reason: safeReason(status, row.error_code),
      updatedAt: safeUpdatedAt(row.updated_at),
    };
  }

  return truthByEntry;
}

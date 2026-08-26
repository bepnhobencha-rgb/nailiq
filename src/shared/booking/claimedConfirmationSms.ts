import {
  claimNotificationOnce,
  finalizeNotificationClaim,
  type NotificationClaim,
  type NotificationFinalStatus,
} from "@/shared/lib/notificationLog";
import { deliverBookingConfirmation } from "@/shared/booking/bookingConfirmationRetryDelivery";
import { sendSmsReminder } from "@/shared/lib/twilioSms";

export type ConfirmationSmsOutcome =
  | "accepted"
  | "suppressed"
  | "rejected"
  | "unknown";

export type ClaimedConfirmationSmsResult = {
  outcome: ConfirmationSmsOutcome;
  reason: string;
  /** Present only when this caller owns the durable booking/channel claim. */
  claimId: string | null;
  /** Present only for a provider receipt that matches Twilio's SID format. */
  messageSid: string | null;
  /** False when this call could not persist its final durable outcome. */
  claimFinalized: boolean;
};

type ProviderResult = Awaited<ReturnType<typeof sendSmsReminder>>;

export type ClaimedConfirmationSmsDeps = {
  claim: typeof claimNotificationOnce;
  send: typeof sendSmsReminder;
  finalize: typeof finalizeNotificationClaim;
};

/** Twilio message receipts are SM or MM followed by exactly 32 hex digits. */
export function isTwilioMessageReceipt(value: unknown): value is string {
  return typeof value === "string" && /^(?:SM|MM)[0-9a-fA-F]{32}$/.test(value);
}

export type DurableConfirmationClassification =
  | {
      complete: true;
      outcome: "accepted" | "suppressed";
      reason:
        | "durable_sent"
        | "durable_delivered"
        | "durable_suppressed";
      messageSid: string | null;
    }
  | {
      complete: false;
      outcome: "unknown";
      reason: string;
      messageSid: null;
    };

/** A duplicate claim is not itself proof of success. Interpret the one durable
 * row without ever reopening the provider boundary. Only a sent row with an
 * exact Twilio receipt, or a receipt-free suppressed row, is terminal success. */
export function classifyDurableConfirmationStatus(
  status: unknown,
  messageSid: unknown,
): DurableConfirmationClassification {
  if (status === "sent" || status === "delivered") {
    return isTwilioMessageReceipt(messageSid)
      ? {
          complete: true,
          outcome: "accepted",
          reason: status === "delivered" ? "durable_delivered" : "durable_sent",
          messageSid,
        }
      : {
          complete: false,
          outcome: "unknown",
          reason: `durable_${status}_receipt_invalid`,
          messageSid: null,
        };
  }

  if (status === "suppressed") {
    return messageSid == null || messageSid === ""
      ? {
          complete: true,
          outcome: "suppressed",
          reason: "durable_suppressed",
          messageSid: null,
        }
      : {
          complete: false,
          outcome: "unknown",
          reason: "durable_suppressed_receipt_present",
          messageSid: null,
        };
  }

  if (
    status === "sending" ||
    status === "unknown" ||
    status === "failed" ||
    status === "undelivered"
  ) {
    return {
      complete: false,
      outcome: "unknown",
      reason: `durable_${status}`,
      messageSid: null,
    };
  }

  return {
    complete: false,
    outcome: "unknown",
    reason: "durable_status_unreadable",
    messageSid: null,
  };
}

function isDefinitiveRejection(error: string | undefined): boolean {
  return (
    error === "invalid_phone" ||
    error === "twilio_not_configured" ||
    /^twilio_[1-5][0-9]{2}$/.test(error ?? "")
  );
}

function classifyProviderResult(result: ProviderResult): {
  outcome: ConfirmationSmsOutcome;
  reason: string;
  messageSid: string | null;
  finalStatus: NotificationFinalStatus;
} {
  if (result.suppressed) {
    return {
      outcome: "suppressed",
      reason: result.suppressionReason ?? "kill_switch",
      // SUPPRESSED_* ids are local markers, not provider receipts.
      messageSid: null,
      finalStatus: "suppressed",
    };
  }

  if (result.ok && isTwilioMessageReceipt(result.messageSid)) {
    return {
      outcome: "accepted",
      reason: "provider_accepted",
      messageSid: result.messageSid,
      finalStatus: "sent",
    };
  }

  if (isDefinitiveRejection(result.error)) {
    return {
      outcome: "rejected",
      reason: result.error ?? "provider_rejected",
      messageSid: null,
      finalStatus: "failed",
    };
  }

  return {
    outcome: "unknown",
    reason:
      result.ok && result.messageSid
        ? "invalid_provider_receipt"
        : result.error ?? "provider_outcome_unknown",
    messageSid: null,
    finalStatus: "unknown",
  };
}

/**
 * Own the durable notification row before crossing the provider boundary.
 * A replay, concurrent loser, or failed claim can never call the provider.
 */
export async function sendClaimedBookingConfirmationSms(
  params: {
    bookingId: string;
    salonId: string;
    clientPhone: string;
    message: string;
    statusCallbackUrl: string;
    salonIsTest: boolean;
    lang: "en" | "vi";
    /** Server-side outbound gate: persist suppression without calling Twilio. */
    suppressionReason?: string;
  },
  deps?: ClaimedConfirmationSmsDeps,
): Promise<ClaimedConfirmationSmsResult> {
  // Production uses the tokenized claim/complete RPC contract and persists the
  // exact versioned dispatch envelope for one bounded cron retry. The optional
  // legacy-shaped dependency seam remains only for the pre-existing focused
  // unit matrix while it is migrated independently; it is never the runtime
  // default.
  if (!deps) {
    const result = await deliverBookingConfirmation({
      bookingId: params.bookingId,
      salonId: params.salonId,
      envelope: {
        v: 1,
        channel: "sms",
        salonId: params.salonId,
        to: params.clientPhone,
        body: params.message,
        statusCallbackUrl: params.statusCallbackUrl,
        salonIsTest: params.salonIsTest,
        lang: params.lang,
      },
      suppressionReason: params.suppressionReason,
    });
    if (result.outcome === "suppressed" && result.reason === "duplicate_terminal") {
      return {
        outcome: "suppressed",
        reason: "duplicate",
        claimId: result.claimId,
        messageSid: null,
        claimFinalized: true,
      };
    }
    return {
      outcome: result.outcome,
      reason: result.reason,
      claimId: result.claimId,
      messageSid: result.providerMessageId,
      claimFinalized: result.finalized,
    };
  }

  let claim: NotificationClaim;
  try {
    claim = await deps.claim({
      bookingId: params.bookingId,
      salonId: params.salonId,
      notificationType: "booking_confirmation",
      channel: "sms",
      clientPhone: params.clientPhone,
      bodyPreview: params.message,
    });
  } catch {
    claim = "unguarded";
  }

  if (claim === "unguarded") {
    return {
      outcome: "unknown",
      reason: "claim_unavailable",
      claimId: null,
      messageSid: null,
      claimFinalized: false,
    };
  }

  if (claim === "skip") {
    return {
      outcome: "suppressed",
      reason: "duplicate",
      claimId: null,
      messageSid: null,
      claimFinalized: true,
    };
  }

  if (params.suppressionReason) {
    const claimFinalized = await finalizeSafely(deps, claim, {
      status: "suppressed",
      messageSid: null,
      errorMessage: params.suppressionReason,
    });
    return {
      outcome: "suppressed",
      reason: params.suppressionReason,
      claimId: claim,
      messageSid: null,
      claimFinalized,
    };
  }

  let providerResult: ProviderResult;
  try {
    providerResult = await deps.send(params.clientPhone, params.message, {
      salonId: params.salonId,
      statusCallbackUrl: params.statusCallbackUrl,
      salonIsTest: params.salonIsTest,
      lang: params.lang,
    });
  } catch {
    // A thrown transport error can happen after the provider accepted the
    // request. Preserve the claim and refuse an automatic replay.
    providerResult = { ok: false, error: "provider_exception" };
  }

  const classified = classifyProviderResult(providerResult);
  const claimFinalized = await finalizeSafely(deps, claim, {
    status: classified.finalStatus,
    messageSid: classified.messageSid,
    errorMessage:
      classified.outcome === "accepted" ? null : classified.reason,
  });

  return {
    outcome: classified.outcome,
    reason: classified.reason,
    claimId: claim,
    messageSid: classified.messageSid,
    claimFinalized,
  };
}

async function finalizeSafely(
  deps: ClaimedConfirmationSmsDeps,
  claimId: string,
  params: {
    status: NotificationFinalStatus;
    messageSid?: string | null;
    errorMessage?: string | null;
  },
): Promise<boolean> {
  try {
    return await deps.finalize(claimId, params);
  } catch {
    return false;
  }
}

import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import { isValidCustomerName } from "@/shared/lib/nameFormat";

export type CapacityRescueKind = "individual" | "sequence" | "group";

export type SubmitCapacityRescueRequestParams = {
  salonId: string;
  requestId: string;
  requestKind: CapacityRescueKind;
  primaryServiceId: string;
  staffId: string | null;
  bookingDateYmd: string;
  preferredSlotLabel: string | null;
  partySize: number;
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  clientLocale: "en" | "vi";
  /** Scheduling constraints only. Never include prices, card/OTP/provider
   * material, health notes, or free-form customer notes. */
  intent: Record<string, unknown> & { serviceIds: string[] };
};

export type CapacityRescueReceipt = {
  requestId: string;
  status: "waiting" | "review_required" | "notified";
  createdNew: boolean;
};

export type CapacityRescueSubmissionResult =
  | {
      outcome: "created";
      availability: "slot_unavailable" | "booking_conflict" | "capacity_unavailable";
      receipt: CapacityRescueReceipt;
    }
  | { outcome: "slot_available"; slotLabel: string }
  | { outcome: "availability_unverified" };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function submitCapacityRescueRequestChecked(
  params: SubmitCapacityRescueRequestParams,
): Promise<CapacityRescueSubmissionResult> {
  const name = params.clientName.trim();
  const email = params.clientEmail.trim().toLowerCase();
  const phone = validateGuestPhone(params.clientPhone);
  const serviceIds = Array.from(new Set(params.intent.serviceIds));

  if (!UUID_RE.test(params.salonId) || !UUID_RE.test(params.requestId)) {
    throw new Error("invalid_request");
  }
  if (!UUID_RE.test(params.primaryServiceId)) {
    throw new Error("invalid_service");
  }
  if (params.staffId !== null && !UUID_RE.test(params.staffId)) {
    throw new Error("invalid_staff");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.bookingDateYmd)) {
    throw new Error("invalid_booking_date");
  }
  if (!isValidCustomerName(name)) throw new Error("invalid_name_chars");
  if (!phone.ok) throw new Error("invalid_phone");
  if (!isValidEmailFormat(email)) throw new Error("invalid_email");
  if (
    serviceIds.length < 1 ||
    serviceIds.length > 20 ||
    serviceIds.some((id) => !UUID_RE.test(id))
  ) {
    throw new Error("invalid_services");
  }
  if (
    !Number.isInteger(params.partySize) ||
    params.partySize < 1 ||
    params.partySize > 20 ||
    (params.requestKind === "group" && params.partySize < 2) ||
    (params.requestKind !== "group" && params.partySize !== 1)
  ) {
    throw new Error("invalid_party_size");
  }

  const response = await fetch("/api/booking/capacity-rescue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...params,
      clientName: name,
      clientPhone: phone.digits,
      clientEmail: email,
      intent: { ...params.intent, serviceIds },
    }),
  }).catch(() => null);
  if (!response) return { outcome: "availability_unverified" };

  const body = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body || typeof body !== "object") {
    return { outcome: "availability_unverified" };
  }
  if (body.code === "slot_available" && typeof body.slotLabel === "string") {
    return { outcome: "slot_available", slotLabel: body.slotLabel };
  }
  if (body.code === "availability_unverified") {
    return { outcome: "availability_unverified" };
  }
  if (!response.ok || body.ok !== true || typeof body.receipt !== "object") {
    throw new Error(
      typeof body.code === "string" ? body.code : "capacity_rescue_failed",
    );
  }
  const raw = body.receipt as Record<string, unknown>;
  const requestId = typeof raw.requestId === "string" ? raw.requestId : "";
  const status = ["waiting", "review_required", "notified"].includes(
    String(raw.status),
  )
    ? (raw.status as CapacityRescueReceipt["status"])
    : null;
  const availability = [
    "slot_unavailable",
    "booking_conflict",
    "capacity_unavailable",
  ].includes(String(body.outcome))
    ? (body.outcome as
        | "slot_unavailable"
        | "booking_conflict"
        | "capacity_unavailable")
    : null;
  if (!requestId || !status || !availability) {
    throw new Error("capacity_rescue_invalid_receipt");
  }
  return {
    outcome: "created",
    availability,
    receipt: {
      requestId,
      status,
      createdNew: raw.createdNew === true,
    },
  };
}

export async function submitCapacityRescueRequest(
  params: SubmitCapacityRescueRequestParams,
): Promise<CapacityRescueReceipt> {
  const result = await submitCapacityRescueRequestChecked(params);
  if (result.outcome !== "created") {
    throw new Error(result.outcome);
  }
  return result.receipt;
}

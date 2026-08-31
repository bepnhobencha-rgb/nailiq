import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import { createPublicClient } from "@/shared/lib/supabase/publicClient";

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function submitCapacityRescueRequest(
  params: SubmitCapacityRescueRequestParams,
): Promise<CapacityRescueReceipt> {
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

  const client = createPublicClient();
  const { data, error } = await client.rpc(
    "create_public_capacity_rescue_request" as never,
    {
      p_salon_id: params.salonId,
      p_request_id: params.requestId,
      p_request_kind: params.requestKind,
      p_primary_service_id: params.primaryServiceId,
      p_staff_id: params.staffId,
      p_booking_date: params.bookingDateYmd,
      p_preferred_slot_label: params.preferredSlotLabel ?? "",
      p_party_size: params.partySize,
      p_client_name: name,
      p_client_phone: phone.digits,
      p_client_email: email,
      p_client_locale: params.clientLocale,
      p_intent_json: { ...params.intent, serviceIds },
    } as never,
  );

  if (error) throw new Error(error.message || "capacity_rescue_failed");
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") throw new Error("capacity_rescue_empty");

  const raw = row as Record<string, unknown>;
  const requestId = typeof raw.id === "string" ? raw.id : "";
  const status =
    raw.status === "waiting" ||
    raw.status === "review_required" ||
    raw.status === "notified"
      ? raw.status
      : null;
  if (!requestId || !status) throw new Error("capacity_rescue_invalid_receipt");

  return {
    requestId,
    status,
    createdNew: raw.created_new === true,
  };
}

import "server-only";

import {
  parseBookingSequenceReceipt,
  type BookingSequenceReceipt,
} from "@/shared/booking/bookingSequenceReceipt";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReceiptLoadResult =
  | { ok: true; receipt: BookingSequenceReceipt }
  | { ok: false; code: "not_sequence" | "sequence_receipt_unavailable" };

export async function loadBookingSequenceReceipt(input: {
  salonId: string;
  bookingId: string;
}): Promise<ReceiptLoadResult> {
  if (!UUID_RE.test(input.salonId) || !UUID_RE.test(input.bookingId)) {
    return { ok: false, code: "sequence_receipt_unavailable" };
  }
  const { data, error } = await createServiceRoleClient().rpc(
    "load_booking_sequence_receipt" as never,
    { p_salon_id: input.salonId, p_booking_id: input.bookingId } as never,
  );
  if (error) return { ok: false, code: "sequence_receipt_unavailable" };
  const row = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
  if (row?.success === false && row.code === "not_sequence") {
    return { ok: false, code: "not_sequence" };
  }
  const receipt = parseBookingSequenceReceipt(data);
  return receipt
    ? { ok: true, receipt }
    : { ok: false, code: "sequence_receipt_unavailable" };
}

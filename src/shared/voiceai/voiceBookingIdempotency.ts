import "server-only";

import { stableBookingIdempotencyKey } from "@/shared/booking/stableBookingIdempotencyKey";

export function voiceBookingLogicalIdempotencyKey(input: {
  sessionId: string | null;
  salonId: string;
  serviceId: string;
  requestedStaffId: string;
  date: string;
  timeSlot: string;
  customerName: string;
  customerPhone: string;
}): string {
  return stableBookingIdempotencyKey({
    channel: "voice",
    sessionId: input.sessionId,
    salonId: input.salonId,
    serviceId: input.serviceId,
    requestedStaffId: input.requestedStaffId,
    date: input.date,
    timeSlot: input.timeSlot,
    customerName: input.customerName.trim(),
    customerPhone: input.customerPhone,
  });
}

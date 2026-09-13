import { handleBookingCardSave } from "@/shared/booking/bookingCardManagementServer";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleBookingCardSave(request);
}

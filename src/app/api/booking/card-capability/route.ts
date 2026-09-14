import { handleBookingCardCapability } from "@/shared/booking/bookingCardManagementServer";

export async function POST(request: Request) {
  return handleBookingCardCapability(request);
}

import { NextResponse } from "next/server";
import { sendBookingConfirmationEmail } from "@/shared/booking/sendBookingConfirmationEmail";

// Temporary diagnostic endpoint — remove after email debugging is done.
// Protected by a static token; not guessable and not linked from anywhere.
export async function POST(req: Request) {
  const token = req.headers.get("x-test-token");
  if (token !== process.env.TEST_EMAIL_SECRET && token !== "nailiq-email-debug-2026") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    await sendBookingConfirmationEmail({
      bookingId: "test-00000000-0000-0000-0000-000000000000",
      shopSlug: "thao-vy-2",
      clientName: "Test User",
      clientEmail: "thehuytgvn@gmail.com",
      serviceName: "Gel Manicure",
      addonServiceName: null,
      staffName: "Tuong Vy",
      startTimeUtc: new Date(Date.now() + 86400000).toISOString(),
      totalPriceCents: 4500,
    });
    return NextResponse.json({ ok: true, message: "sendBookingConfirmationEmail ran — check logs" });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

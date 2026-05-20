import { after } from "next/server";
import { NextResponse } from "next/server";
import { sendBookingConfirmationEmail } from "@/shared/booking/sendBookingConfirmationEmail";

// Internal-only endpoint called by submitPublicBooking server action.
// Using after() guarantees the email is sent after the response is flushed,
// keeping this Vercel function alive until Resend responds — unlike a void
// async call inside a server action which dies with the action's function.
export async function POST(req: Request) {
  const token = req.headers.get("x-internal-secret");
  const secret = (process.env.INTERNAL_API_SECRET ?? "").trim();

  if (!secret || token !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let payload: Parameters<typeof sendBookingConfirmationEmail>[0];
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  after(async () => {
    try {
      await sendBookingConfirmationEmail(payload);
    } catch (e) {
      console.error("[booking-email/after] threw", e);
    }
  });

  return NextResponse.json({ ok: true });
}

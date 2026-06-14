import { NextResponse } from "next/server";
import {
  evaluateBookingNoShow,
  type EvaluateBookingNoShowInput,
} from "@/shared/noshow/evaluateBookingNoShow";

/**
 * Internal route kept for server-to-server callers. The public booking flow now
 * runs evaluateBookingNoShow() directly from a server action (the browser can't
 * send INTERNAL_API_SECRET), so this is no longer on the online booking path.
 */
export async function POST(req: Request) {
  const secret = (process.env.INTERNAL_API_SECRET ?? "").trim();
  if (secret && req.headers.get("x-internal-secret") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let body: EvaluateBookingNoShowInput;
  try {
    body = (await req.json()) as EvaluateBookingNoShowInput;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  await evaluateBookingNoShow(body);
  return NextResponse.json({ ok: true });
}

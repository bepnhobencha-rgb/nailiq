import { after } from "next/server";
import { NextResponse } from "next/server";
import { sendReminderEmail } from "@/shared/noshow/sendReminderEmail";
import type { ReminderEmailInput } from "@/shared/noshow/sendReminderEmail";

export const runtime = "nodejs";

/**
 * Internal route: send a reminder email after() the response returns.
 * Protected by INTERNAL_API_SECRET header.
 */
export async function POST(req: Request) {
  const secret = (process.env.INTERNAL_API_SECRET ?? "").trim();
  if (secret && req.headers.get("x-internal-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: ReminderEmailInput;
  try {
    body = (await req.json()) as ReminderEmailInput;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  after(async () => {
    const result = await sendReminderEmail(body);
    if (!result.ok) {
      console.error("[booking-reminder-email] send failed", result.error);
    }
  });

  return NextResponse.json({ ok: true });
}

import { after } from "next/server";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { notifyWaitlistForSlot } from "@/shared/noshow/waitlistAutoFill";

export async function POST(req: Request) {
  let body: { token?: string };
  try {
    body = (await req.json()) as { token?: string };
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_body" }, { status: 400 });
  }

  const token = (body.token ?? "").trim();
  if (!token) {
    return NextResponse.json({ ok: false, code: "missing_token" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  // Pre-fetch booking details needed for waitlist notification
  const { data: tokenRow } = await supabase
    .from("booking_reminder_tokens" as never)
    .select("booking_id")
    .eq("id", token)
    .maybeSingle();
  const tr = tokenRow as { booking_id: string } | null;

  type BookingMeta = { salon_id: string; service_id: string; start_time_utc: string };
  let bookingMeta: BookingMeta | null = null;
  if (tr) {
    const { data: bRow } = await supabase
      .from("bookings" as never)
      .select("salon_id, service_id, start_time_utc")
      .eq("id", tr.booking_id)
      .maybeSingle();
    bookingMeta = bRow as BookingMeta | null;
  }

  const { data, error } = await supabase.rpc("cancel_booking_as_customer" as never, {
    p_token_id: token,
  });

  if (error) {
    console.error("[cancel-action] RPC error", error);
    return NextResponse.json({ ok: false, code: "server_error" }, { status: 500 });
  }

  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as { ok?: boolean; code?: string } | undefined;

  if (!row?.ok) {
    return NextResponse.json({ ok: false, code: row?.code ?? "unknown" }, { status: 400 });
  }

  // Fire waitlist notification email after response is sent
  if (bookingMeta) {
    const { salon_id, service_id, start_time_utc } = bookingMeta;
    const bookingDateYmd = start_time_utc.split("T")[0];
    after(async () => {
      const sb = createServiceRoleClient();
      const [{ data: salonData }, { data: svcData }] = await Promise.all([
        sb.from("salons" as never).select("name").eq("id", salon_id).maybeSingle(),
        sb.from("services" as never).select("name").eq("id", service_id).maybeSingle(),
      ]);
      const salonName = (salonData as { name: string } | null)?.name ?? "";
      const serviceName = (svcData as { name: string } | null)?.name ?? "";
      await notifyWaitlistForSlot({ salonId: salon_id, salonName, serviceId: service_id, serviceName, bookingDateYmd });
    });
  }

  return NextResponse.json({ ok: true });
}

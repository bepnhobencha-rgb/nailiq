import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { TRYON_COOKIE } from "@/shared/nailTryOn/server";
import { verifySessionCredential } from "@/shared/nailTryOn/sessionCredential";
import { recordNailTryOnEvent } from "@/shared/nailTryOn/telemetry";

const schema = z.object({ sessionId: z.string().uuid(), bookingId: z.string().uuid() });
type SessionRow = { id: string; salon_id: string; design_id: string; design_version: number; anonymous_token_hash: string; status: string };
type BookingRow = { id: string; salon_id: string; created_at: string; end_time_utc: string };
type DesignRow = { id: string; name: string; version: number; palette: unknown; service_id: string | null; addon_service_id: string | null };

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const db = createServiceRoleClient();
  const { data: rawSession } = await db.from("nail_tryon_sessions" as never)
    .select("id, salon_id, design_id, design_version, anonymous_token_hash, status")
    .eq("id", parsed.data.sessionId).maybeSingle();
  const session = rawSession as unknown as SessionRow | null;
  const credential = (await cookies()).get(TRYON_COOKIE)?.value;
  if (!session || !verifySessionCredential(credential, session.id, session.anonymous_token_hash)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (session.status !== "ready" && session.status !== "attached") {
    return NextResponse.json({ error: "invalid_state" }, { status: 409 });
  }

  const { data: rawBooking } = await db.from("bookings" as never)
    .select("id, salon_id, created_at, end_time_utc").eq("id", parsed.data.bookingId).maybeSingle();
  const booking = rawBooking as unknown as BookingRow | null;
  const freshAfter = Date.now() - 30 * 60 * 1000;
  if (!booking || booking.salon_id !== session.salon_id || Date.parse(booking.created_at) < freshAfter) {
    return NextResponse.json({ error: "booking_not_found" }, { status: 404 });
  }

  const { data: rawDesign } = await db.from("nail_designs" as never)
    .select("id, name, version, palette, service_id, addon_service_id").eq("id", session.design_id).maybeSingle();
  const design = rawDesign as unknown as DesignRow | null;
  if (!design) return NextResponse.json({ error: "design_not_found" }, { status: 404 });

  const { error: attachError } = await db.from("booking_nail_looks" as never).upsert({
    salon_id: session.salon_id,
    booking_id: booking.id,
    tryon_session_id: session.id,
    design_id: design.id,
    design_version: session.design_version || design.version,
    design_snapshot: {
      name: design.name,
      version: session.design_version || design.version,
      palette: design.palette,
      serviceId: design.service_id,
      addonServiceId: design.addon_service_id,
    },
    disclaimer_version: "nail-tryon-v1",
  } as never, { onConflict: "booking_id" });
  if (attachError) return NextResponse.json({ error: "attach_failed" }, { status: 500 });

  const expiresAt = new Date(Date.parse(booking.end_time_utc) + 30 * 24 * 60 * 60 * 1000).toISOString();
  await db.from("nail_tryon_sessions" as never).update({
    status: "attached", attached_at: new Date().toISOString(), expires_at: expiresAt, updated_at: new Date().toISOString(),
  } as never).eq("id", session.id);
  await recordNailTryOnEvent({ salonId: session.salon_id, sessionId: session.id, event: "booking_attached", properties: { designVersion: session.design_version || design.version } });
  return NextResponse.json({ ok: true });
}

import { jwtVerify } from "jose";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { createClient } from "@/shared/lib/supabase/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ phone: string }> };

type CustomerJwtPayload = {
  photo_id?: string;
  phone?: string;
  iat?: number;
  exp?: number;
};

async function isValidCustomerJwt(
  authHeader: string | null,
  routePhone: string,
): Promise<boolean> {
  if (!authHeader) return false;
  const secret = process.env.JWT_SECRET;
  if (!secret) return false;

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  try {
    const secretBytes = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, secretBytes);
    const p = payload as unknown as CustomerJwtPayload;
    // Accept if token carries a matching phone, or if it carries a photo_id
    // (customer arrived via their SMS link — trust the route phone they own)
    return p.phone === routePhone || typeof p.photo_id === "string";
  } catch {
    return false;
  }
}

/**
 * PATCH /api/customer/:phone/consents
 * Body: { revoked_reason?, salon_id? }
 *
 * PIPEDA revocation: revokes all photo consents + soft-deletes customer's photos.
 * Auth: must be authenticated salon member OR a valid customer JWT (photo view token).
 */
export async function PATCH(req: Request, { params }: Params) {
  const { phone } = await params;
  const decodedPhone = decodeURIComponent(phone).trim();

  if (!decodedPhone) {
    return NextResponse.json({ ok: false, error: "missing_phone" }, { status: 400 });
  }

  let body: { revoked_reason?: string; salon_id?: string };
  try {
    body = (await req.json()) as { revoked_reason?: string; salon_id?: string };
  } catch {
    body = {};
  }

  const revokedReason = body.revoked_reason?.trim() ?? "customer_request";
  const requestedSalonId = body.salon_id?.trim() ?? null;

  // Determine auth
  const serverClient = await createClient();
  const {
    data: { user },
  } = await serverClient.auth.getUser();

  const authHeader = req.headers.get("authorization");
  const customerJwtValid = await isValidCustomerJwt(authHeader, decodedPhone);

  const db = createServiceRoleClient();
  const now = new Date().toISOString();

  let salonIds: string[] = [];

  if (user) {
    // Salon member path
    const { data: memberships } = await db
      .from("salon_members")
      .select("salon_id")
      .eq("user_id", user.id);

    if (!memberships || memberships.length === 0) {
      if (!customerJwtValid) {
        return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
      }
      // Fall through to customer JWT path — salonIds stays empty (revoke all)
    } else {
      salonIds = memberships.map((m) => m.salon_id as string);
      if (requestedSalonId) {
        if (!salonIds.includes(requestedSalonId)) {
          return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
        }
        salonIds = [requestedSalonId];
      }
    }
  } else if (!customerJwtValid) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // customerJwtValid path: salonIds is empty → revoke all salons for this customer

  // Revoke consent(s)
  let consentUpdate = db
    .from("customer_photo_consents")
    .update({ revoked_at: now, revoked_reason: revokedReason, updated_at: now })
    .eq("client_phone", decodedPhone)
    .is("revoked_at", null);

  if (salonIds.length > 0) {
    consentUpdate = consentUpdate.in("salon_id", salonIds);
  }

  const { error: consentErr } = await consentUpdate;
  if (consentErr) {
    console.error("[consents] Revocation error:", consentErr);
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }

  // Soft-delete booking photos for this customer
  // Get relevant booking IDs for this phone
  let bookingQuery = db
    .from("bookings")
    .select("id")
    .eq("client_phone", decodedPhone);

  if (salonIds.length > 0) {
    bookingQuery = bookingQuery.in("salon_id", salonIds);
  }

  const { data: bookingRows } = await bookingQuery;

  if (bookingRows && bookingRows.length > 0) {
    const ids = bookingRows.map((b) => b.id as string);
    let photoUpdate = db
      .from("booking_photos")
      .update({ deleted_at: now })
      .in("booking_id", ids)
      .is("deleted_at", null);

    if (salonIds.length > 0) {
      photoUpdate = photoUpdate.in("salon_id", salonIds);
    }

    const { error: photoErr } = await photoUpdate;
    if (photoErr) {
      console.error("[consents] Photo soft-delete error:", photoErr);
      // Non-fatal
    }
  }

  return NextResponse.json({ ok: true });
}

/**
 * GET /api/customer/:phone/consents?salon_id=X
 * Returns current consent state for a customer.
 */
export async function GET(req: Request, { params }: Params) {
  const { phone } = await params;
  const { searchParams } = new URL(req.url);
  const salonId = searchParams.get("salon_id");

  if (!salonId) return NextResponse.json({ ok: false, error: "missing_salon_id" }, { status: 400 });

  const serverClient = await createClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { data: membership } = await serverClient
    .from("salon_members")
    .select("id")
    .eq("salon_id", salonId)
    .eq("user_id", user.id)
    .single();

  if (!membership) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const db = createServiceRoleClient();
  const { data } = await db
    .from("customer_photo_consents")
    .select("*")
    .eq("salon_id", salonId)
    .eq("client_phone", phone)
    .is("revoked_at", null)
    .maybeSingle();

  return NextResponse.json({ ok: true, consents: data });
}

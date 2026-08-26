import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { createClient } from "@/shared/lib/supabase/server";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import { verifyPhotoCustomerToken } from "@/shared/photos/photoCustomerToken";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ phone: string }> };

function bearerToken(authHeader: string | null): string | null {
  const match = /^Bearer\s+([^\s]+)$/i.exec(authHeader?.trim() ?? "");
  return match?.[1] ?? null;
}

/**
 * PATCH /api/customer/:phone/consents
 * Body: { revoked_reason?, salon_id? }
 *
 * PIPEDA revocation: revokes all photo consents + soft-deletes customer's photos.
 * Auth: authenticated same-salon member OR a purpose-bound photo customer JWT
 * whose photo, salon, and canonical booking phone all match this request.
 */
export async function PATCH(req: Request, { params }: Params) {
  if (!isSameOriginMutation(req, { allowBearerWithoutCookie: true })) {
    return NextResponse.json({ ok: false, error: "invalid_origin" }, { status: 403 });
  }
  const { phone } = await params;
  const decodedPhone = toCanonicalPhone(decodeURIComponent(phone));

  if (!decodedPhone) {
    return NextResponse.json({ ok: false, error: "missing_phone" }, { status: 400 });
  }

  const rate = await consumePublicRequestRateLimit({
    request: req,
    scope: "customer-consent-revoke",
    identity: [decodedPhone],
    ipLimits: [[10, 300], [30, 3_600]],
    identityLimits: [[3, 3_600], [5, 86_400]],
  });
  if (rate !== "allowed") {
    return NextResponse.json(
      { ok: false, error: rate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      { status: rate === "limited" ? 429 : 503 },
    );
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

  let salonIds: string[] = [];
  let customerClaims: Awaited<ReturnType<typeof verifyPhotoCustomerToken>> = null;

  if (user) {
    // Salon member path
    const { data: memberships, error: membershipError } = await serverClient
      .from("salon_members")
      .select("salon_id")
      .eq("user_id", user.id);

    if (membershipError) {
      return NextResponse.json({ ok: false, error: "temporarily_unavailable" }, { status: 503 });
    }
    if (!memberships || memberships.length === 0) {
      const token = bearerToken(req.headers.get("authorization"));
      customerClaims = token ? await verifyPhotoCustomerToken(token) : null;
      if (!customerClaims) {
        return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
      }
    } else {
      salonIds = memberships.map((m) => m.salon_id as string);
      if (requestedSalonId) {
        if (!salonIds.includes(requestedSalonId)) {
          return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
        }
        salonIds = [requestedSalonId];
      }
    }
  } else {
    const token = bearerToken(req.headers.get("authorization"));
    customerClaims = token ? await verifyPhotoCustomerToken(token) : null;
    if (!customerClaims) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  // The customer bearer is purpose-bound and carries the exact salon/phone.
  // Reject cross-customer and cross-tenant attempts before creating a
  // service-role client or reading any protected row.
  if (customerClaims) {
    if (
      customerClaims.phone !== decodedPhone ||
      (requestedSalonId !== null && requestedSalonId !== customerClaims.salonId)
    ) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }
    salonIds = [customerClaims.salonId];
  }

  const db = createServiceRoleClient();
  if (customerClaims) {
    type PhotoBinding = {
      id?: string;
      salon_id?: string;
      bookings?:
        | { client_phone?: string | null; salon_id?: string | null }
        | { client_phone?: string | null; salon_id?: string | null }[]
        | null;
    };
    const { data: rawPhoto, error: photoBindingError } = await db
      .from("booking_photos")
      .select("id, salon_id, bookings!inner(client_phone, salon_id)")
      .eq("id", customerClaims.photoId)
      .eq("salon_id", customerClaims.salonId)
      .is("deleted_at", null)
      .maybeSingle();
    const photo = rawPhoto as PhotoBinding | null;
    const booking = Array.isArray(photo?.bookings)
      ? photo?.bookings[0]
      : photo?.bookings;
    if (
      photoBindingError ||
      !photo?.id ||
      photo.salon_id !== customerClaims.salonId ||
      booking?.salon_id !== customerClaims.salonId ||
      toCanonicalPhone(booking?.client_phone ?? "") !== decodedPhone
    ) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }
  }

  const now = new Date().toISOString();

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
  const canonicalPhone = toCanonicalPhone(decodeURIComponent(phone));
  const { searchParams } = new URL(req.url);
  const salonId = searchParams.get("salon_id");

  if (!salonId || !canonicalPhone) return NextResponse.json({ ok: false, error: "missing_salon_id" }, { status: 400 });

  const rate = await consumePublicRequestRateLimit({
    request: req,
    scope: "customer-consent-read",
    identity: [salonId, canonicalPhone],
    ipLimits: [[30, 60], [200, 3_600]],
    identityLimits: [[30, 300], [200, 3_600]],
  });
  if (rate !== "allowed") {
    return NextResponse.json(
      { ok: false, error: rate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      { status: rate === "limited" ? 429 : 503 },
    );
  }

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
    .eq("client_phone", canonicalPhone)
    .is("revoked_at", null)
    .maybeSingle();

  return NextResponse.json({ ok: true, consents: data });
}

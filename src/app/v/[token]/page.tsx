// Public photo view page — /v/[token]
// No auth required. Decodes JWT token, shows nail photo + rating UI.

import type { Metadata } from "next";
import { jwtVerify } from "jose";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import PhotoViewClient from "./_components/PhotoViewClient";

type Props = { params: Promise<{ token: string }> };

export const metadata: Metadata = {
  title: "Your Nails · NailIQ",
  description: "View and rate your nail appointment results.",
  robots: { index: false, follow: false },
};

type JwtPayload = {
  photo_id: string;
  iat?: number;
  exp?: number;
};

async function decodePhotoToken(token: string): Promise<string | null> {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const secretBytes = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, secretBytes);
    const photoId = (payload as unknown as JwtPayload).photo_id;
    return typeof photoId === "string" ? photoId : null;
  } catch {
    return null;
  }
}

export default async function PhotoViewPage({ params }: Props) {
  const { token } = await params;

  const photoId = await decodePhotoToken(token);
  if (!photoId) {
    return <TokenErrorPage reason="invalid" />;
  }

  const db = createServiceRoleClient();

  // Fetch photo row + related booking + salon
  const { data: photoRow } = await db
    .from("booking_photos")
    .select(
      `
      id,
      storage_path,
      thumbnail_path,
      customer_viewed_at,
      customer_rating,
      salon_id,
      bookings (
        client_name,
        start_time_utc,
        services!bookings_service_id_fkey ( name ),
        staff ( name ),
        salon_id
      )
    `,
    )
    .eq("id", photoId)
    .is("deleted_at", null)
    .maybeSingle();

  if (!photoRow) {
    return <TokenErrorPage reason="not_found" />;
  }

  // Record first view
  if (!photoRow.customer_viewed_at) {
    await db
      .from("booking_photos")
      .update({ customer_viewed_at: new Date().toISOString() })
      .eq("id", photoId);
  }

  // Get salon info for re-book CTA
  const { data: salon } = await db
    .from("salons")
    .select("name, slug")
    .eq("id", photoRow.salon_id)
    .maybeSingle();

  // Generate signed URL (24-hour expiry for the public view)
  const { data: signedData } = await db.storage
    .from("booking-photos")
    .createSignedUrl(photoRow.storage_path, 60 * 60 * 24);

  const photoUrl = signedData?.signedUrl ?? null;

  // Resolve booking nested relations
  type BookingRef = {
    client_name: string;
    start_time_utc: string | null;
    services: { name: string } | { name: string }[] | null;
    staff: { name: string } | { name: string }[] | null;
  } | null;

  const booking = (
    Array.isArray(photoRow.bookings) ? photoRow.bookings[0] : photoRow.bookings
  ) as BookingRef;

  const serviceName =
    booking?.services
      ? Array.isArray(booking.services)
        ? booking.services[0]?.name
        : booking.services.name
      : null;

  const staffName =
    booking?.staff
      ? Array.isArray(booking.staff)
        ? booking.staff[0]?.name
        : booking.staff.name
      : null;

  return (
    <PhotoViewClient
      photoId={photoId}
      photoUrl={photoUrl}
      token={token}
      clientName={booking?.client_name ?? ""}
      serviceName={serviceName ?? "Nail Service"}
      staffName={staffName ?? undefined}
      appointmentDate={booking?.start_time_utc ?? undefined}
      salonName={salon?.name ?? ""}
      salonSlug={salon?.slug ?? ""}
      alreadyRated={photoRow.customer_rating != null}
    />
  );
}

function TokenErrorPage({ reason }: { reason: "invalid" | "not_found" | "expired" }) {
  const messages: Record<string, { heading: string; body: string }> = {
    invalid: {
      heading: "Link not valid",
      body: "This link may be expired or incorrect. Please check your SMS and try again.",
    },
    not_found: {
      heading: "Photo not found",
      body: "This photo may have been removed. Contact your salon for help.",
    },
    expired: {
      heading: "Link expired",
      body: "This link has expired. Photo links are valid for 30 days.",
    },
  };

  const { heading, body } = messages[reason] ?? messages.invalid;

  return (
    <div
      className="min-h-dvh flex flex-col items-center justify-center p-6"
      style={{ background: "#0b0c10" }}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-8 text-center"
        style={{ background: "#111214", border: "1px solid rgba(255,255,255,0.08)" }}
      >
        <div className="text-4xl mb-4">🔗</div>
        <h1 className="text-lg font-semibold text-white mb-2">{heading}</h1>
        <p className="text-sm text-[#a1a1aa]">{body}</p>
      </div>
    </div>
  );
}

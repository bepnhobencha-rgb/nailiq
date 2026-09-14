export type TrendCandidatePhoto = {
  id?: unknown;
  salon_id?: unknown;
  bookings?:
    | { client_phone?: unknown; salon_id?: unknown }
    | { client_phone?: unknown; salon_id?: unknown }[]
    | null;
  [key: string]: unknown;
};

export type CurrentPublicPhotoConsent = {
  salon_id?: unknown;
  client_phone?: unknown;
  consent_share_public?: unknown;
  revoked_at?: unknown;
};

function bookingFor(photo: TrendCandidatePhoto) {
  return Array.isArray(photo.bookings)
    ? photo.bookings[0] ?? null
    : photo.bookings ?? null;
}

export function filterCurrentPublicTrendPhotos<T extends TrendCandidatePhoto>(
  photos: readonly T[],
  consents: readonly CurrentPublicPhotoConsent[],
): T[] {
  const allowed = new Set<string>();
  for (const consent of consents) {
    if (
      typeof consent.salon_id === "string" &&
      typeof consent.client_phone === "string" &&
      consent.consent_share_public === true &&
      consent.revoked_at == null
    ) {
      allowed.add(`${consent.salon_id}\u0000${consent.client_phone}`);
    }
  }

  return photos.filter((photo) => {
    const booking = bookingFor(photo);
    return Boolean(
      typeof photo.id === "string" &&
      typeof photo.salon_id === "string" &&
      typeof booking?.client_phone === "string" &&
      booking.client_phone &&
      booking.salon_id === photo.salon_id &&
      allowed.has(`${photo.salon_id}\u0000${booking.client_phone}`),
    );
  });
}

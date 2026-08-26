export type NailTryOnSalonEligibility = {
  vertical?: string | null;
};

export type PublicNailTryOnSalonEligibility = NailTryOnSalonEligibility & {
  archived_at?: string | null;
  profile_complete?: boolean | null;
};

/**
 * Nail Try-On is a nail-salon-only surface. The release flag controls rollout;
 * the vertical controls whether the product is relevant to the tenant.
 */
export function isNailTryOnEligibleSalon(
  salon: NailTryOnSalonEligibility,
): boolean {
  return salon.vertical === "nail_salon";
}

/**
 * Public Try-On ends in the same salon's booking flow. Fail closed unless that
 * destination is active and booking-ready, so a private image session can
 * never lead customers to an archived or incomplete salon.
 */
export function isPublicNailTryOnEligibleSalon(
  salon: PublicNailTryOnSalonEligibility,
): boolean {
  return (
    isNailTryOnEligibleSalon(salon) &&
    salon.archived_at === null &&
    salon.profile_complete === true
  );
}

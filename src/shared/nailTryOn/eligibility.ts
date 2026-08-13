export type NailTryOnSalonEligibility = {
  vertical?: string | null;
};

/**
 * Nail Try-On is a nail-salon-only surface.
 *
 * Keep this separate from the release flag: the flag controls rollout, while
 * the salon vertical controls product eligibility. Both gates must pass.
 */
export function isNailTryOnEligibleSalon(
  salon: NailTryOnSalonEligibility,
): boolean {
  return salon.vertical === "nail_salon";
}

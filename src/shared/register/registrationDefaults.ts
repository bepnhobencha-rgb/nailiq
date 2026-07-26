import { PLAN_LIMITS } from "@/shared/lib/subscriptionPlans";
import { DEFAULT_VERTICAL, resolveVertical } from "@/shared/verticals/registry";

/**
 * Default service catalogue for a newly-created Free/trial salon.
 *
 * Keep the seed inside the plan limit so the owner never lands in a state
 * where the catalogue already exceeds the advertised cap.
 */
export function buildRegistrationDefaultServices(salonId: string) {
  return resolveVertical(DEFAULT_VERTICAL)
    .seedServices.slice(0, PLAN_LIMITS.free.maxServices)
    .map((service) => ({ ...service, salon_id: salonId }));
}

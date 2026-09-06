import { PLAN_LIMITS } from "@/shared/lib/subscriptionPlans";
import { DEFAULT_VERTICAL, resolveVertical } from "@/shared/verticals/registry";

/**
 * A new salon is a draft workspace, not a live business.
 *
 * Keep every customer-facing or money-adjacent automation off until the
 * Owner completes Coco Setup and approves the corresponding policy. These
 * explicit values intentionally override older database defaults so a schema
 * restored from a production baseline cannot silently send messages.
 */
export const REGISTRATION_SAFE_SALON_DEFAULTS = {
  profile_complete: false,
  sms_outbound_enabled: false,
  email_outbound_enabled: false,
  email_links_enabled: false,
  reminders_enabled: false,
  reminder_24h_enabled: false,
  reminder_3h_enabled: false,
  sms_reminders_enabled: false,
  voice_ai_enabled: false,
  noshow_protection_enabled: false,
  winback_enabled: false,
  payment_provider: null,
} as const;

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

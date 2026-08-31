export type EmailAudience = "customer" | "owner" | "operator" | "security";
export type EmailConsentClass = "transactional" | "optional" | "marketing" | "system";
export type EmailDeliveryTruth =
  | "customer_booking"
  | "owner_booking"
  | "booking_otp"
  | "domain_outbox_and_registered_webhook"
  | "registered_webhook";

export type EmailExperienceDefinition = {
  audience: EmailAudience;
  consent: EmailConsentClass;
  deliveryTruth: EmailDeliveryTruth;
  sourceModules: readonly string[];
};

/**
 * Canonical inventory for every production module that can dispatch email.
 *
 * This registry is deliberately honest about delivery evidence. Provider
 * acceptance is not described as inbox delivery; signed receipts and stronger
 * domain ledgers have distinct classes. New sender modules must be added here
 * so review can see their audience, consent class, and reconciliation boundary.
 */
export const EMAIL_EXPERIENCE_REGISTRY = {
  ai_digest: {
    audience: "owner",
    consent: "system",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/ai/agentDigest.ts"],
  },
  ai_approval: {
    audience: "owner",
    consent: "system",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/ai/approvalRequests.ts"],
  },
  owner_alert: {
    audience: "owner",
    consent: "system",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/ai/sendOwnerAlert.ts"],
  },
  booking_confirmation: {
    audience: "customer",
    consent: "transactional",
    deliveryTruth: "customer_booking",
    sourceModules: [
      "src/shared/booking/bookingConfirmationRetryDelivery.ts",
      "src/shared/booking/sendBookingConfirmationEmail.ts",
      "src/shared/booking/sendGroupBookingConfirmationEmail.ts",
    ],
  },
  contact_inquiry: {
    audience: "operator",
    consent: "system",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/contact/submitContactInquiry.ts"],
  },
  email_verification: {
    audience: "security",
    consent: "transactional",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/dashboard/sendEmailVerification.ts"],
  },
  owner_booking_alert: {
    audience: "owner",
    consent: "system",
    deliveryTruth: "owner_booking",
    sourceModules: ["src/shared/dashboard/sendOwnerBookingNotification.ts"],
  },
  review_request: {
    audience: "customer",
    consent: "marketing",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/dashboard/sendReviewRequest.ts"],
  },
  first_visit_follow_up: {
    audience: "customer",
    consent: "marketing",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/firstvisit/agentFirstVisit.ts"],
  },
  booking_otp: {
    audience: "security",
    consent: "transactional",
    deliveryTruth: "booking_otp",
    sourceModules: ["src/shared/lib/emailOtp.ts"],
  },
  customer_link: {
    audience: "customer",
    consent: "transactional",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/lib/sendCustomerLinkEmail.ts"],
  },
  waitlist_offer: {
    audience: "customer",
    consent: "optional",
    deliveryTruth: "domain_outbox_and_registered_webhook",
    sourceModules: ["src/shared/noshow/deliverPromotedWaitlistOffer.ts"],
  },
  waitlist_offer_legacy: {
    audience: "customer",
    consent: "optional",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/noshow/waitlistAutoFill.ts"],
  },
  booking_reminder: {
    audience: "customer",
    consent: "optional",
    deliveryTruth: "customer_booking",
    sourceModules: ["src/shared/noshow/sendReminderEmail.ts"],
  },
  winback: {
    audience: "customer",
    consent: "marketing",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/noshow/sendWinBackEmail.ts"],
  },
  booking_transition: {
    audience: "customer",
    consent: "transactional",
    deliveryTruth: "customer_booking",
    sourceModules: ["src/shared/notifications/customerBookingTransitionEmail.ts"],
  },
  staff_booking_action: {
    audience: "customer",
    consent: "transactional",
    deliveryTruth: "domain_outbox_and_registered_webhook",
    sourceModules: [
      "src/shared/notifications/staffActionNotificationWorker.ts",
    ],
  },
  staff_booking_action_legacy: {
    audience: "customer",
    consent: "transactional",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/notifications/deliverStaffActionNotification.ts"],
  },
  incident_alert: {
    audience: "operator",
    consent: "system",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/observability/triageError.ts"],
  },
  referral_reward: {
    audience: "customer",
    consent: "marketing",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/referrals/sendReferralRewardEmail.ts"],
  },
  reoptin_campaign: {
    audience: "customer",
    consent: "marketing",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/reoptin/reoptinCampaign.ts"],
  },
  platform_announcement: {
    audience: "owner",
    consent: "system",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/superadmin/platformAnnouncementEmail.ts"],
  },
  release_review: {
    audience: "operator",
    consent: "system",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/superadmin/releaseReviewEmail.ts"],
  },
  provider_connection_test: {
    audience: "operator",
    consent: "system",
    deliveryTruth: "registered_webhook",
    sourceModules: ["src/shared/superadmin/superadminActions.ts"],
  },
  website_import_complete: {
    audience: "owner",
    consent: "system",
    deliveryTruth: "registered_webhook",
    sourceModules: ["supabase/functions/scrape-website/index.ts"],
  },
} as const satisfies Record<string, EmailExperienceDefinition>;

export type EmailExperienceKey = keyof typeof EMAIL_EXPERIENCE_REGISTRY;

export function isEmailExperienceKey(value: string): value is EmailExperienceKey {
  return Object.prototype.hasOwnProperty.call(EMAIL_EXPERIENCE_REGISTRY, value);
}

export function emailExperienceDefinition(key: EmailExperienceKey): EmailExperienceDefinition {
  return EMAIL_EXPERIENCE_REGISTRY[key];
}

export function registeredEmailSourceModules(): readonly string[] {
  return Object.values(EMAIL_EXPERIENCE_REGISTRY)
    .flatMap((definition) => [...definition.sourceModules])
    .sort();
}

export function emailExperienceTags(key: EmailExperienceKey): Array<{ name: string; value: string }> {
  const definition = emailExperienceDefinition(key);
  return [
    { name: "nailiq_email", value: key },
    { name: "nailiq_audience", value: definition.audience },
  ];
}

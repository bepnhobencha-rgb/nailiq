export type PublicBookingConsentRequirements = {
  /** Express consent is required only when this salon has enabled outbound SMS. */
  smsConsentRequired: boolean;
};

export function resolvePublicBookingConsentRequirements(input: {
  smsOutboundEnabled?: boolean | null;
} | null): PublicBookingConsentRequirements {
  return {
    smsConsentRequired: input?.smsOutboundEnabled === true,
  };
}

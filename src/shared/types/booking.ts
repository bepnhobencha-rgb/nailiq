// Shared booking-related types used by both API routes and frontend components.

export type VoiceParseResult = {
  serviceId: string | null;
  serviceName: string | null;
  staffId: string | null;
  staffName: string | null;
  dateHint: string | null;
  timeHint: string | null;
  clientName: string | null;
  clientPhone: string | null;
};

export type VoiceChatMessage = { role: "user" | "assistant"; content: string };

export type VoiceChatResponse = {
  reply: string;
  fill: {
    serviceId: string | null;
    serviceName: string | null;
    staffId: string | null;
    staffName: string | null;
    dateHint: string | null;
    timeHint: string | null;
    clientName: string | null;
    clientPhone: string | null;
  };
  done: boolean;
};

export type VerificationAction =
  | "none"
  | "otp_optional"
  | "otp_required"
  | "deposit_required"
  | "deposit_or_otp";

export type VerifyDecisionResponse = {
  action: VerificationAction;
  risk_score: number;
  deposit_amount_cents: number;
  reason: string;
};

import type { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { normaliseToE164 } from "@/shared/lib/twilioSms";
import type { SupportedLanguage } from "@/shared/voiceai/config";

type SupabaseServiceClient = ReturnType<typeof createServiceRoleClient>;

type TwilioVoiceCredentials = {
  accountSid: string;
  authToken: string;
  platformPhone: string | null;
};

const TWILIO_CALL_SID = /^CA[a-fA-F0-9]{32}$/;

function xmlEscape(value: string): string {
  return value.replace(/[<>&'"]/g, (character) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[
      character
    ] ?? character,
  );
}

async function getTwilioVoiceCredentials(
  supabase: SupabaseServiceClient,
): Promise<TwilioVoiceCredentials | null> {
  try {
    const { data } = await supabase
      .from("platform_settings")
      .select("twilio_account_sid, twilio_auth_token, twilio_phone_number")
      .eq("id", "platform")
      .maybeSingle();

    const row = data as {
      twilio_account_sid?: string | null;
      twilio_auth_token?: string | null;
      twilio_phone_number?: string | null;
    } | null;
    const accountSid = row?.twilio_account_sid?.trim();
    const authToken = row?.twilio_auth_token?.trim();
    if (accountSid && authToken) {
      return {
        accountSid,
        authToken,
        platformPhone: normaliseToE164(row?.twilio_phone_number ?? ""),
      };
    }
  } catch {
    // Fall through to environment variables.
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) return null;
  return {
    accountSid,
    authToken,
    platformPhone: normaliseToE164(process.env.TWILIO_PHONE_NUMBER ?? ""),
  };
}

export function callTransferSuppressReason(): string | null {
  const flag = process.env.DISABLE_OUTBOUND_CALLS?.trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") {
    return "disabled_by_env";
  }
  if (process.env.NODE_ENV !== "production") {
    return "non_production_env";
  }
  return null;
}

const FALLBACK_COPY: Record<SupportedLanguage, { language: string; text: string }> = {
  en: {
    language: "en-CA",
    text: "Sorry, no one is available to take the call. The salon has your message and will follow up.",
  },
  vi: {
    language: "vi-VN",
    text: "Dạ xin lỗi, hiện chưa có người nghe máy. Salon đã nhận được lời nhắn và sẽ liên hệ lại ạ.",
  },
  es: {
    language: "es-MX",
    text: "Lo sentimos, nadie está disponible para atender la llamada. El salón recibió su mensaje y se comunicará con usted.",
  },
  fr: {
    language: "fr-CA",
    text: "Désolé, personne ne peut prendre l'appel. Le salon a reçu votre message et vous recontactera.",
  },
  zh: {
    language: "cmn-CN",
    text: "抱歉，目前没有工作人员接听。美甲店已经收到您的留言，会尽快联系您。",
  },
};

/**
 * Redirect Twilio's active inbound call to a human. If the human destination
 * is busy, rejects, or does not answer within 25 seconds, Twilio continues to
 * the short fallback message. The AI records/notifies the owner before calling
 * this helper, so that fallback statement is always true.
 */
export function buildHumanTransferTwiml(
  destinationE164: string,
  actionUrl: string,
): string {
  return (
    "<Response>" +
      `<Dial answerOnBridge="true" timeout="25" action="${xmlEscape(actionUrl)}" method="POST">` +
        `<Number>${xmlEscape(destinationE164)}</Number>` +
      "</Dial>" +
    "</Response>"
  );
}

export function buildHumanTransferResultTwiml(
  dialCallStatus: string,
  language: SupportedLanguage,
): string {
  if (dialCallStatus === "completed") {
    return "<Response><Hangup/></Response>";
  }
  const fallback = FALLBACK_COPY[language] ?? FALLBACK_COPY.en;
  return (
    "<Response>" +
      `<Say language="${fallback.language}">${xmlEscape(fallback.text)}</Say>` +
      "<Hangup/>" +
    "</Response>"
  );
}

export async function transferActiveTwilioCall(args: {
  supabase: SupabaseServiceClient;
  callSid: string;
  destinationPhone: string;
  calledPhone?: string | null;
  language: SupportedLanguage;
  statusCallbackUrl: string;
}): Promise<
  | { ok: true }
  | { ok: false; error: "invalid_call" | "invalid_destination" | "transfer_loop" | "not_configured" | "suppressed" | "twilio_error" }
> {
  const callSid = args.callSid.trim();
  if (!TWILIO_CALL_SID.test(callSid)) return { ok: false, error: "invalid_call" };

  const destination = normaliseToE164(args.destinationPhone);
  if (!destination) return { ok: false, error: "invalid_destination" };

  const calledPhone = args.calledPhone ? normaliseToE164(args.calledPhone) : null;
  if (calledPhone && calledPhone === destination) {
    return { ok: false, error: "transfer_loop" };
  }

  const suppressed = callTransferSuppressReason();
  if (suppressed) {
    console.info(`[voice-transfer] suppressed (${suppressed})`);
    return { ok: false, error: "suppressed" };
  }

  const credentials = await getTwilioVoiceCredentials(args.supabase);
  if (!credentials) return { ok: false, error: "not_configured" };
  if (credentials.platformPhone && credentials.platformPhone === destination) {
    return { ok: false, error: "transfer_loop" };
  }

  const endpoint =
    `https://api.twilio.com/2010-04-01/Accounts/` +
    `${encodeURIComponent(credentials.accountSid)}/Calls/${encodeURIComponent(callSid)}.json`;
  const authorization = Buffer.from(
    `${credentials.accountSid}:${credentials.authToken}`,
  ).toString("base64");

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authorization}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        Twiml: buildHumanTransferTwiml(destination, args.statusCallbackUrl),
      }),
    });
    if (!response.ok) {
      console.error("[voice-transfer] Twilio update failed", response.status);
      return { ok: false, error: "twilio_error" };
    }
    return { ok: true };
  } catch (error) {
    console.error(
      "[voice-transfer] Twilio update failed",
      error instanceof Error ? error.message : String(error),
    );
    return { ok: false, error: "twilio_error" };
  }
}

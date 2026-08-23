/**
 * POST /api/twilio/sms
 * Twilio inbound-SMS webhook. Configure a salon's Twilio number Messaging URL:
 *   https://nailiq.ca/api/twilio/sms?slug=<salon-slug>
 *
 * Runs the SAME AI receptionist brain as web + phone (buildSystemPrompt +
 * REALTIME_TOOLS + the /api/voice/tool handlers) over an Anthropic text tool-use
 * loop, carrying conversation state per (salon, phone) in sms_agent_sessions.
 *
 * Identity: an SMS `From` is NOT treated as verified (unlike a voice call's
 * carrier caller-ID), so this route deliberately does NOT send the bridge secret
 * / callerVerifiedPhone. Every booking mutation therefore forces an OTP round
 * trip — which also defends against `From` spoofing (a spoofer without the SIM
 * never receives the code).
 *
 * Signature-validated (X-Twilio-Signature). Reply is sent via the compliant
 * outbound sender (kill-switch + opt-out), and we return empty TwiML.
 */
import { NextRequest, NextResponse } from "next/server";
import { createTextBackgroundAnthropicClient } from "@/shared/ai/anthropicProviderPolicy";
import { trackAnthropicMessage } from "@/shared/ai/usageLedger";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getTwilioAuthToken, validateTwilioSignature, twilioRequestBaseUrl } from "@/shared/lib/twilioSignature";
import { loadSalonContext } from "@/shared/voiceai/loadSalonContext";
import { buildSystemPrompt } from "@/shared/voiceai/buildSystemPrompt";
import { REALTIME_TOOLS } from "@/shared/voiceai/realtimeTools";
import { sendSmsReminder, normaliseToE164 } from "@/shared/lib/twilioSms";
import { readUrlEncodedFormWithLimit } from "@/shared/security/readUrlEncodedFormWithLimit";
import { classifyInboundSmsCommand } from "@/shared/reminders/inboundSmsCommand";
import { recordInboundSmsConsent } from "@/shared/reminders/smsConsentSuppression";
import {
  runSmsAgent,
  toAnthropicTools,
  trimHistory,
  SMS_AGENT_MODEL,
  SMS_MAX_HISTORY,
  SMS_MAX_REPLY_TOKENS,
  type StoredTurn,
  type LlmComplete,
  type ContentBlock,
  type RealtimeToolSchema,
} from "@/shared/voiceai/smsAgent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
function emptyTwiml(): NextResponse {
  return new NextResponse(EMPTY_TWIML, { status: 200, headers: { "Content-Type": "text/xml" } });
}

function internalOrigin(req: NextRequest): string {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || req.nextUrl.origin;
}

// Transport-specific delta appended to the SHARED system prompt — the brain is
// identical, only the medium changes (short plain text; the customer TYPES the
// OTP code rather than reading it aloud).
const SMS_CHANNEL_NOTE =
  "\n\nYou are now replying over SMS TEXT (not voice). Keep every reply under 300 " +
  "characters, plain text, no markdown or emoji. The customer TYPES the verification " +
  "code — never say 'read it back'. Verify identity with request_otp then verify_otp " +
  "before any booking change.";

export async function POST(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug")?.trim();
  const form = await readUrlEncodedFormWithLimit(req, 16_384);
  if (!form) return new NextResponse("Invalid request", { status: 400 });
  const params = Object.fromEntries(form.entries());

  let supabase: ReturnType<typeof createServiceRoleClient>;
  try {
    supabase = createServiceRoleClient();
  } catch {
    return emptyTwiml(); // never 500 at Twilio; just stay silent
  }

  // Signature check — Twilio signs the FULL request URL incl. the ?slug= query.
  const authToken = await getTwilioAuthToken(supabase);
  if (!authToken) {
    console.error("[twilio/sms] auth token unavailable");
    return new NextResponse("Service unavailable", { status: 503 });
  }
  const signature = req.headers.get("x-twilio-signature") ?? "";
  const fullUrl = `${twilioRequestBaseUrl(req)}/api/twilio/sms${req.nextUrl.search}`;
  if (!validateTwilioSignature(fullUrl, params, signature, authToken)) {
    console.warn("[twilio/sms] invalid signature");
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Advanced Opt-Out is provider-authoritative. Persist the signed STOP/START
  // receipt before loading salon/AI state and return empty TwiML because Twilio
  // already sends the configured reply. This prevents an AI response from
  // bypassing or duplicating carrier opt-out handling.
  const inboundCommand = classifyInboundSmsCommand(params.Body ?? "", params.OptOutType);
  if (inboundCommand === "consent_help") return emptyTwiml();
  if (inboundCommand === "consent_stop" || inboundCommand === "consent_start") {
    const recorded = await recordInboundSmsConsent({
      accountSid: params.AccountSid ?? "",
      messageSid: params.MessageSid ?? params.SmsMessageSid ?? "",
      fromPhone: params.From ?? "",
      toPhone: params.To ?? "",
      optOutType: inboundCommand === "consent_stop" ? "STOP" : "START",
    });
    return recorded.ok
      ? emptyTwiml()
      : new NextResponse("Service unavailable", { status: 503 });
  }

  const fromRaw = params.From ?? "";
  const userText = (params.Body ?? "").trim();
  const from = normaliseToE164(fromRaw);
  if (!slug || !from || !userText) return emptyTwiml();

  // Gate: salon exists + voice AI on (the AI receptionist master switch, shared
  // across web/phone/SMS for pilot). Also read the reply language.
  const { data: salonRow } = await supabase
    .from("salons")
    .select("id, voice_ai_enabled, default_language")
    .eq("slug", slug)
    .maybeSingle();
  const salon = salonRow as { id?: string; voice_ai_enabled?: boolean | null; default_language?: string | null } | null;
  if (!salon?.id || salon.voice_ai_enabled !== true) return emptyTwiml();

  const lang: "en" | "vi" = salon.default_language === "vi" ? "vi" : "en";

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    console.warn("[twilio/sms] ANTHROPIC_API_KEY not set");
    return emptyTwiml();
  }

  // Load prior conversation turns (clean alternating plain text).
  const { data: sessionRow } = await supabase
    .from("sms_agent_sessions")
    .select("messages")
    .eq("salon_id", salon.id)
    .eq("phone", from)
    .maybeSingle();
  const history: StoredTurn[] = Array.isArray((sessionRow as { messages?: unknown } | null)?.messages)
    ? ((sessionRow as { messages: StoredTurn[] }).messages)
    : [];

  // Build the SHARED brain: same context + system prompt + tools as web/phone.
  const ctx = await loadSalonContext(slug);
  if (!ctx) return emptyTwiml();
  const system = buildSystemPrompt(ctx, lang) + SMS_CHANNEL_NOTE;
  const tools = toAnthropicTools(REALTIME_TOOLS as unknown as RealtimeToolSchema[]);

  const ai = createTextBackgroundAnthropicClient(apiKey);
  const complete: LlmComplete = async ({ system: sys, tools: t, messages }) => {
    const resp = await trackAnthropicMessage(
      {
        salonId: salon.id!,
        feature: "sms_receptionist",
        model: SMS_AGENT_MODEL,
      },
      () => ai.messages.create({
        model: SMS_AGENT_MODEL,
        max_tokens: SMS_MAX_REPLY_TOKENS,
        system: sys,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: t as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: messages as any,
      }),
    );
    return { stop_reason: resp.stop_reason, content: resp.content as unknown as ContentBlock[] };
  };

  // Execute tool calls against the SAME handlers the phone/web path uses. No
  // bridge secret / callerVerifiedPhone → mutations force OTP (see file header).
  const toolUrl = `${internalOrigin(req)}/api/voice/tool`;
  const callTool = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    const r = await fetch(toolUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: name, toolArgs: input, salonSlug: slug }),
    });
    return r.json().catch(() => ({ error: "tool_parse_failed" }));
  };

  let reply: string;
  let turns: StoredTurn[];
  try {
    const out = await runSmsAgent({ system, tools, history, userText, complete, callTool });
    reply = out.reply;
    turns = out.turns;
  } catch (err) {
    console.error("[twilio/sms] agent error", err);
    return emptyTwiml();
  }

  // Send the reply (compliant sender: kill-switch in non-prod + opt-out line).
  await sendSmsReminder(from, reply, { salonId: salon.id, lang });

  // Persist the trimmed conversation for the next inbound text.
  const nextMessages = trimHistory([...history, ...turns], SMS_MAX_HISTORY);
  await supabase
    .from("sms_agent_sessions")
    .upsert(
      { salon_id: salon.id, phone: from, messages: nextMessages, updated_at: new Date().toISOString() },
      { onConflict: "salon_id,phone" },
    );

  return emptyTwiml();
}

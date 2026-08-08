import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { trackAnthropicMessage } from "@/shared/ai/usageLedger";

/**
 * AI Smart Reminder — personalises the SMS reminder LEAD line (the part before
 * the confirm/reschedule links), adapting tone to the customer's no-show risk:
 * a gentle "please confirm so we hold your spot" for risky/new guests, a warm
 * light nudge for trusted regulars. The links + STOP opt-out stay deterministic
 * (compliance), and guardReminderLead clamps the AI text. Returns null on any
 * failure → the caller keeps the fixed template. (Email reminders already use AI
 * via sendReminderEmail; this brings SMS up to the same level.)
 */

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!client) client = new Anthropic({ apiKey: key });
  return client;
}

export async function draftReminderLead(input: {
  salonId: string;
  clientName: string;
  serviceName: string;
  salonName: string;
  whenLabel: string; // "tomorrow" | "in 3 hours" (already localised by caller)
  timeLabel: string; // e.g. "2:30 PM"
  riskScore: number | null;
  lang: "en" | "vi";
}): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;

  const langLabel = input.lang === "vi" ? "tiếng Việt" : "English";
  const risk =
    input.riskScore == null
      ? "unknown"
      : input.riskScore >= 70
        ? "high"
        : input.riskScore >= 40
          ? "medium"
          : "low";
  const prompt = `Write ONE short, warm SMS appointment-reminder line in ${langLabel} (no links — they are appended automatically).

Details: ${input.clientName || "the guest"} has a ${input.serviceName} at ${input.salonName} ${input.whenLabel} at ${input.timeLabel}.
No-show risk: ${risk}.
Tone: if risk is high or medium, warmly ask them to tap Confirm so we can hold their spot; if low or unknown, a friendly light reminder. ALWAYS include the salon name "${input.salonName}", the service, and "${input.whenLabel} at ${input.timeLabel}".

Rules: ONE line, max 200 characters, NO emojis, NO links/URLs, no "Reply STOP" (added separately). Return ONLY the line.`;

  try {
    const model = "claude-haiku-4-5-20251001";
    const resp = await trackAnthropicMessage(
      { salonId: input.salonId, feature: "smart_reminder", model },
      () =>
        ai.messages.create({
          model,
          max_tokens: 160,
          messages: [{ role: "user", content: prompt }],
        }),
    );
    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    return text.replace(/^["']|["']$/g, "").trim() || null;
  } catch {
    return null;
  }
}

/** Deterministic guard for the AI lead: one line, no emoji, no stray link, has
 *  the salon name, length-clamped. Returns null → caller uses the fixed lead. */
export function guardReminderLead(text: string, salonName: string): string | null {
  let t = (text || "").replace(/\s+/g, " ").trim();
  t = t
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu,
      "",
    )
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 240) return null;
  if (salonName && !t.toLowerCase().includes(salonName.toLowerCase())) return null;
  return t;
}

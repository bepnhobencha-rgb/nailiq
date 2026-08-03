import Anthropic from "@anthropic-ai/sdk";
import { trackAnthropicMessage } from "@/shared/ai/usageLedger";

export type RiskScoreInput = {
  salonId: string;
  clientName: string;
  serviceName: string;
  startTimeUtc: string;
  isNewCustomer: boolean;
  visitCount: number;
  noShowCount: number;
  bookingSource: string;
  hasEmail: boolean;
  hasPhone: boolean;
  /** Vertical descriptor for the prompt, e.g. "a nail salon" / "a head spa".
   *  Defaults to a generic appointment business when not supplied. */
  businessDescriptor?: string;
};

export type RiskScoreResult = {
  score: number; // 0–100 (higher = more likely to no-show)
  reasoning: string;
};

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: key });
  return anthropicClient;
}

/**
 * AI-based no-show risk scoring using Claude Haiku.
 * Falls back to deterministic score if API is unavailable.
 * Cost: ~$0.0002 per booking.
 */
export async function scoreNoShowRisk(
  input: RiskScoreInput,
): Promise<RiskScoreResult> {
  const client = getClient();

  if (!client) {
    return deterministicScore(input);
  }

  const businessDescriptor = input.businessDescriptor?.trim() || "an appointment-based business";
  const prompt = `You are a no-show risk analyst for ${businessDescriptor} booking system.
Score the likelihood this customer will not show up (0 = very likely to show, 100 = very likely to no-show).

Customer data:
- New customer: ${input.isNewCustomer}
- Total visits: ${input.visitCount}
- Previous no-shows: ${input.noShowCount}
- Has email: ${input.hasEmail}
- Has phone: ${input.hasPhone}
- Booking source: ${input.bookingSource}
- Appointment time: ${new Date(input.startTimeUtc).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}

Respond with JSON only: {"score": <0-100>, "reasoning": "<1 sentence>"}`;

  try {
    const model = "claude-haiku-4-5-20251001";
    const response = await trackAnthropicMessage(
      { salonId: input.salonId, feature: "noshow_risk_score", model },
      () => client.messages.create({
        model,
        max_tokens: 100,
        messages: [{ role: "user", content: prompt }],
      }),
    );

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const parsed = JSON.parse(text.trim()) as { score?: unknown; reasoning?: unknown };
    const score = typeof parsed.score === "number" ? Math.min(100, Math.max(0, Math.round(parsed.score))) : deterministicScore(input).score;
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
    return { score, reasoning };
  } catch {
    return deterministicScore(input);
  }
}

function deterministicScore(input: RiskScoreInput): RiskScoreResult {
  let score = 20; // base risk

  if (input.isNewCustomer) score += 25;
  if (input.noShowCount > 0) score += input.noShowCount * 20;
  if (!input.hasEmail) score += 10;
  if (!input.hasPhone) score += 10;
  if (input.visitCount > 5) score -= 15;

  score = Math.min(100, Math.max(0, score));
  return {
    score,
    reasoning: `Deterministic: ${input.isNewCustomer ? "new customer" : "returning"}, ${input.noShowCount} previous no-shows`,
  };
}

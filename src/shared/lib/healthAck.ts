import { resolveVertical } from "@/shared/verticals/registry";

/**
 * Whether the booking flow must require the customer health-acknowledgment tick.
 * Per-salon override (`salons.health_ack_required`) wins; NULL falls back to the
 * vertical default (massage / head spa / facial / waxing default ON).
 */
export function healthAckRequired(
  salonOverride: boolean | null | undefined,
  verticalSlug?: string | null,
): boolean {
  if (typeof salonOverride === "boolean") return salonOverride;
  return resolveVertical(verticalSlug).healthAckDefault === true;
}

/** The acknowledgment statement the customer ticks. Privacy-light: ticking it
 *  records consent/disclosure responsibility — it does NOT collect structured
 *  health data (any details go in the optional free-text note). */
export function healthAckText(lang: "en" | "vi", salonName: string): string {
  const s = salonName || (lang === "vi" ? "tiệm" : "the salon");
  return lang === "vi"
    ? `Tôi xác nhận đã báo ${s} về việc mang thai, chấn thương hoặc tình trạng sức khoẻ có thể ảnh hưởng đến dịch vụ, và hiểu ${s} có thể điều chỉnh hoặc từ chối dịch vụ vì an toàn của tôi.`
    : `I confirm I have informed ${s} of any pregnancy, injuries, or health conditions that could affect my service, and understand ${s} may adjust or decline a service for my safety.`;
}

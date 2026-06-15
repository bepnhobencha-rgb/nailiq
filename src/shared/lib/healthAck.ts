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

/**
 * The acknowledgment statement the customer ticks at booking.
 *
 * Legally framed as a FORWARD-LOOKING undertaking + safety notice, NOT a past
 * attestation. The old wording ("I confirm I HAVE informed you…") forced the
 * customer to assert a fact that is usually false at online-booking time (there
 * is no person to tell yet) — which destroys its evidentiary value and can be
 * read as a coerced/misleading form. Instead we (1) warn about the concrete,
 * vertical-specific contraindications and (2) capture the customer's agreement
 * to disclose them before the service. That is true at tick-time and supports
 * the salon's duty-of-care / assumption-of-risk position.
 *
 * It is an acknowledgment, NOT a liability waiver — it does not release the
 * salon's own negligence. Privacy-light: ticking records consent only; it does
 * NOT collect structured health data (details go in the optional free-text note).
 */
export function healthAckText(
  lang: "en" | "vi",
  salonName: string,
  verticalSlug?: string | null,
): string {
  const s = salonName || (lang === "vi" ? "tiệm" : "the salon");
  const v = resolveVertical(verticalSlug);
  // Vertical-specific warning (head spa ≠ massage ≠ waxing), reused from the
  // booking-terms copy so the two stay in sync and stay editable per vertical.
  const warn = v.legalServiceRisk?.[lang]?.trim();
  const role = (v.staffRoleLabel?.[lang] ?? (lang === "vi" ? "nhân viên" : "the team")).toLowerCase();
  const commit =
    lang === "vi"
      ? `Tôi đồng ý sẽ báo cho ${role} về bất cứ điều gì liên quan trước khi làm, và hiểu ${s} có thể điều chỉnh, dời hoặc từ chối dịch vụ vì an toàn của tôi.`
      : `I agree to inform my ${role} of anything relevant before my appointment, and I understand ${s} may adjust, postpone, or decline a service for my safety.`;
  return warn ? `${warn} ${commit}` : commit;
}

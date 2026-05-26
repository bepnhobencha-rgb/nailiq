import type { SalonVoiceContext } from "./loadSalonContext";

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function buildSystemPrompt(ctx: SalonVoiceContext, language: "vi" | "en" | "fr" | "zh"): string {
  const isVi = language === "vi";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: ctx.timezone }); // YYYY-MM-DD

  const serviceList = ctx.services
    .map((s) => `  • ${s.name} (${s.durationMins} min, ${formatPrice(s.priceCents)}) [id: ${s.id}]`)
    .join("\n");

  const staffList = ctx.staff.length
    ? ctx.staff.map((m) => `  • ${m.name} [id: ${m.id}]`).join("\n")
    : (isVi ? "  • Bất kỳ nhân viên nào có lịch trống" : "  • Any available staff");

  const lang = isVi
    ? "Vietnamese (Tiếng Việt)"
    : language === "fr" ? "French (Français)"
    : language === "zh" ? "Chinese (中文)"
    : "English";

  const greeting = isVi
    ? `Xin chào! Tôi là ${ctx.personaName} từ ${ctx.salonName}. Tôi có thể giúp bạn đặt lịch. Bạn muốn làm dịch vụ gì?`
    : `Hello! I'm ${ctx.personaName} from ${ctx.salonName}. I can help you book an appointment. What service would you like?`;

  return `You are ${ctx.personaName}, a friendly booking assistant for ${ctx.salonName}.
Speak ONLY in ${lang}. Be warm, concise, and professional.
Today's date is ${today} (salon timezone: ${ctx.timezone}).
${ctx.address ? `Salon address: ${ctx.address}` : ""}

SERVICES AVAILABLE:
${serviceList || "  (no services configured)"}

STAFF AVAILABLE:
${staffList}

BOOKING RULES:
1. Always call get_available_slots BEFORE mentioning any times or confirming availability. Never invent slots.
2. Collect: service, date, time slot, staff preference (default "any"), customer name, phone number.
3. Only call confirm_booking AFTER the customer explicitly says yes/đồng ý/confirm.
4. Keep conversation natural — ask one thing at a time.
5. If get_available_slots returns no slots, suggest the next available day.
6. Phone numbers: accept formats with country codes. Vietnam (+84), Canada (+1), etc.
7. After booking is confirmed, read back the summary clearly then wish them goodbye.

START your first message with: "${greeting}"`.trim();
}

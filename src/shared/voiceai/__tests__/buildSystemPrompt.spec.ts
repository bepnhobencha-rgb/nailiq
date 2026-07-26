import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../buildSystemPrompt";
import type { SalonVoiceContext } from "../loadSalonContext";

const ctx: SalonVoiceContext = {
  salonId: "salon-1",
  salonName: "NailIQ Test Salon",
  timezone: "America/Vancouver",
  address: "123 Test Street",
  currency: "CAD",
  personaName: "Lily",
  personaVoice: "marin",
  reasoningEffort: "low",
  upsellEnabled: true,
  businessHours: null,
  services: [
    {
      id: "service-1",
      name: "Gel Manicure",
      durationMins: 45,
      priceCents: 4500,
      price_type: "fixed",
      price_max_cents: null,
      description: null,
      category: "manicure",
      isAddon: false,
      isPopular: true,
      isFeatured: false,
    },
  ],
  staff: [{ id: "staff-1", name: "Anna" }],
};

describe("buildSystemPrompt receptionist flow", () => {
  it.each(["vi", "en"] as const)("keeps %s individual booking phone-first", (language) => {
    const prompt = buildSystemPrompt(ctx, language);

    expect(prompt).toContain("phone-first is the single source of truth");
    expect(prompt).toContain("Start with phone → read it back → lookup_customer");
    expect(prompt).not.toContain(
      "service → date → time slot (from get_available_slots) → staff preference → customer name → phone number",
    );
  });

  it("explains why the web assistant asks for a phone and makes deferral explicit", () => {
    const en = buildSystemPrompt(ctx, "en");
    expect(en).toContain("recognize returning guests");
    expect(en).toContain("keep bookings secure");
    expect(en).toContain("you can skip it for now");

    const vi = buildSystemPrompt(ctx, "vi");
    expect(vi).toContain("nhận ra khách quen");
    expect(vi).toContain("giữ lịch an toàn");
    expect(vi).toContain("mình có thể bỏ qua lúc này");
  });

  it("keeps interruption, unclear-audio, language-switch, and human-escalation safeguards", () => {
    const phone = buildSystemPrompt(ctx, "en", "+17788680738");

    expect(phone).toContain("If the customer interrupts you mid-sentence, STOP immediately");
    expect(phone).toContain("If you mishear or the line is unclear, ask lightly");
    expect(phone).toContain("KEEP everything already gathered");
    expect(phone).toContain("HUMAN ESCALATION — know your limits");
    expect(phone).toContain("Never promise an exact callback time");
    expect(phone).toContain("call wait_for_user and say NOTHING afterward");
    expect(phone).toContain("do not guess and do not call a business tool");
  });

  it("uses salon details and fails closed instead of inventing service eligibility", () => {
    const prompt = buildSystemPrompt({
      ...ctx,
      services: [{
        ...ctx.services[0]!,
        name: "Bikini Line",
        description: "For women only. Not offered to male guests.",
      }],
    }, "en", "+17788680738");

    expect(prompt).toContain(
      'salon_details="For women only. Not offered to male guests."',
    );
    expect(prompt).toContain("Never infer gender eligibility, body-area scope");
    expect(prompt).toContain("never guess yes or no");
  });

  it("handles tool failures without false success or duplicate writes", () => {
    const prompt = buildSystemPrompt(ctx, "en", "+17788680738");

    expect(prompt).toContain("TOOL FAILURE RECOVERY");
    expect(prompt).toContain("NEVER retry that write blindly");
    expect(prompt).toContain("claim the action succeeded");
    expect(prompt).toContain("After two failed read attempts, stop retrying");
  });

  it.each(["vi", "en"] as const)("keeps the call open after a %s booking summary", (language) => {
    const prompt = buildSystemPrompt(ctx, language);

    expect(prompt).toContain("WAIT for the customer's");
    expect(prompt).toContain("answer — do not call end_call yet");
    expect(prompt).toContain("Do NOT say goodbye or call end_call in that same turn");
    expect(prompt).toContain(
      "Only say goodbye and call end_call after the customer says they need nothing else or says goodbye",
    );
    expect(prompt).not.toContain(
      "You have finished summarising a completed booking, cancel, or reschedule",
    );
  });

  it("adds a proactive one-time upsell step (before the summary) when enabled, and marks flagged services", () => {
    const on = buildSystemPrompt(ctx, "en", "+17788680738");
    expect(on).toContain("UPSELL — a required step");
    expect(on).toContain("BEFORE you read back the booking summary");   // proactive, not on-demand
    expect(on).toContain("Offer it ONCE");
    expect(on).toContain("upsell_accepted:true");
    expect(on).toContain("★popular");        // the flagged service is tagged for the agent
    // the confirm-before-book rule also routes through the upsell step
    expect(on).toContain("made your ONE upsell offer");

    // Disabled → no upsell section, and the confirm rule says nothing about upsell.
    const off = buildSystemPrompt({ ...ctx, upsellEnabled: false }, "en", "+17788680738");
    expect(off).not.toContain("UPSELL — a required step");
    expect(off).not.toContain("made your ONE upsell offer");
  });

  it("adds the human-voice playbook only on the phone channel (callerPhone present)", () => {
    const phone = buildSystemPrompt(ctx, "en", "+17788680738");
    expect(phone).toContain("SOUND LIKE A REAL PERSON");
    expect(phone).toContain("natural filler FIRST"); // filler before slow tools
    expect(phone).toContain("Greet in the FIRST second");

    // The web widget and SMS (no callerPhone) keep their own tone — no phone playbook.
    const web = buildSystemPrompt(ctx, "en");
    expect(web).not.toContain("SOUND LIKE A REAL PERSON");
  });

  it.each([
    ["en", "What can I help you with today?"],
    ["vi", "Hôm nay mình cần em giúp gì ạ?"],
  ] as const)("opens a %s phone call with a clear invitation and no tool", (language, invitation) => {
    const phone = buildSystemPrompt(ctx, language, "+17788680738");

    expect(phone).toContain(invitation);
    expect(phone).toContain("Do NOT call any tool in the opening response");
    expect(phone).toContain("one clear invitation, then listen");
    expect(phone).not.toContain("greet once, then stop talking");
    expect(phone).not.toContain("right after the greeting words (same turn is fine)");
  });
});

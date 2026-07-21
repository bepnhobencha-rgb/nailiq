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

  it("adds a tasteful one-time upsell section when enabled, and marks flagged services", () => {
    const on = buildSystemPrompt(ctx, "en", "+17788680738");
    expect(on).toContain("UPSELL — one gentle offer");
    expect(on).toContain("Offer it ONCE");
    expect(on).toContain("upsell_accepted:true");
    expect(on).toContain("★popular");        // the flagged service is tagged for the agent

    // Disabled → no upsell section at all.
    const off = buildSystemPrompt({ ...ctx, upsellEnabled: false }, "en", "+17788680738");
    expect(off).not.toContain("UPSELL — one gentle offer");
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
});

import { describe, expect, it } from "vitest";

import {
  buildPhoneGreeting,
  buildPhoneSystemPrompt,
} from "../buildPhoneSystemPrompt";
import type { SalonVoiceContext } from "../loadSalonContext";
import { PHONE_REALTIME_TOOLS, REALTIME_TOOLS } from "../realtimeTools";

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "description")
      .map(([key, nested]) => [key, withoutDescriptions(nested)]),
  );
}

const ctx: SalonVoiceContext = {
  salonId: "salon-1",
  salonName: "Tech Nails Salon",
  timezone: "America/Vancouver",
  address: "123 Test Street",
  currency: "CAD",
  personaName: "Lily",
  personaVoice: "marin",
  reasoningEffort: "low",
  upsellEnabled: true,
  businessHours: null,
  services: [{
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
  }],
  staff: [{ id: "staff-1", name: "Anna" }],
};

describe("compact phone Realtime config", () => {
  it.each([
    ["en", "Tech Nails Salon"],
    ["vi", "Tech Nails Salon"],
    ["es", "Tech Nails Salon"],
    ["fr", "Tech Nails Salon"],
    ["zh", "Tech Nails Salon"],
  ] as const)("pins the exact salon name in the %s greeting", (language, salonName) => {
    const greeting = buildPhoneGreeting(ctx, language);
    expect(greeting).toContain(salonName);
    expect(greeting).not.toContain("Aurora");
    expect(greeting).not.toContain("Luna Glow");
  });

  it("retains booking and safety gates without the verbose web prompt", () => {
    const prompt = buildPhoneSystemPrompt(ctx, "en", "+17780000000");
    expect(prompt).toContain('named exactly "Tech Nails Salon"');
    expect(prompt).toContain("Never invent, substitute, translate, or rename the salon");
    expect(prompt).toContain("Carrier-verified caller number: +17780000000");
    expect(prompt).toContain("A chosen time is not booking consent");
    expect(prompt).toContain("never retry a timed-out write");
    expect(prompt).toContain("call wait_for_user and say nothing");
    expect(prompt).toContain("clear yes");
    expect(prompt).toContain("Gel Manicure");
    expect(prompt).toContain("Anna");
  });

  it("requires one real-menu upsell and rechecks availability after acceptance", () => {
    const prompt = buildPhoneSystemPrompt({
      ...ctx,
      services: [
        {
          ...ctx.services[0]!,
          name: "Manicure W/ Reg Polish",
          isPopular: false,
        },
        {
          ...ctx.services[0]!,
          id: "service-shellac",
          name: "Manicure Shellac",
          priceCents: 5200,
          isPopular: true,
        },
        {
          ...ctx.services[0]!,
          id: "service-combo",
          name: "Mani-pedi W/ Shellac",
          priceCents: 8500,
          isPopular: false,
        },
      ],
    }, "en", "+17780000000");

    expect(prompt).toContain("Sales checkpoint — required once");
    expect(prompt).toContain("Manicure Shellac");
    expect(prompt).toContain("Mani-pedi W/ Shellac");
    expect(prompt).toContain("call get_available_slots AGAIN");
    expect(prompt).toContain("Keep the tentative time only if it is returned");
    expect(prompt).toContain("Never repeat the offer");
  });

  it("does not require an upsell when the salon disables it", () => {
    const prompt = buildPhoneSystemPrompt(
      { ...ctx, upsellEnabled: false },
      "en",
      "+17780000000",
    );
    expect(prompt).not.toContain("Sales checkpoint — required once");
  });

  it("pins the approved Vietnamese farewell instead of letting the model paraphrase it", () => {
    const vietnamesePrompt = buildPhoneSystemPrompt(ctx, "vi", "+17780000000");
    const englishPrompt = buildPhoneSystemPrompt(ctx, "en", "+17780000000");

    expect(vietnamesePrompt).toContain(
      'Vietnamese farewell must be exactly: "Dạ, cảm ơn anh/chị đã gọi. Chúc anh/chị một ngày an lành ạ."',
    );
    expect(vietnamesePrompt).toContain("Do not paraphrase it.");
    expect(englishPrompt).not.toContain("một ngày an lành");
  });

  it("uses explicit salon service details and fails closed on eligibility questions", () => {
    const prompt = buildPhoneSystemPrompt({
      ...ctx,
      services: [
        {
          ...ctx.services[0]!,
          id: "bikini-line",
          name: "Bikini Line",
          description: "For women only. Not offered to male guests.",
        },
        {
          ...ctx.services[0]!,
          id: "head-spa",
          name: "Head Spa",
          description: null,
        },
      ],
    }, "en", "+17780000000");

    expect(prompt).toContain(
      'salon_details="For women only. Not offered to male guests."',
    );
    expect(prompt).toContain(
      "Never infer gender eligibility, body-area scope, included steps",
    );
    expect(prompt).toContain(
      "If salon_details do not answer a service-policy question",
    );
    expect(prompt).toContain("Never guess yes or no");
  });

  it("treats common Vietnamese no-more-help replies as a graceful close", () => {
    const prompt = buildPhoneSystemPrompt(ctx, "vi", "+17780000000");
    expect(prompt).toContain('"không cần gì nữa"');
    expect(prompt).toContain('"thôi được rồi"');
    expect(prompt).toContain('a closing "cảm ơn"');
    expect(prompt).toContain("speak the farewell first");
  });

  it("keeps shared tool contracts, adds the phone-only transfer tool, and materially reduces static context", () => {
    const fullTools = REALTIME_TOOLS as unknown as Array<{
      name: string;
      parameters: unknown;
    }>;
    const phoneTools = PHONE_REALTIME_TOOLS as Array<{
      name: string;
      parameters: unknown;
    }>;
    expect(phoneTools.slice(0, -1).map((tool) => tool.name)).toEqual(
      fullTools.map((tool) => tool.name),
    );
    expect(phoneTools.at(-1)?.name).toBe("transfer_to_human");
    expect(phoneTools.every((tool) =>
      typeof (tool as { description?: unknown }).description === "string"
    )).toBe(true);
    expect(phoneTools.slice(0, -1).map((tool) => tool.parameters)).toEqual(
      fullTools.map((tool) => withoutDescriptions(tool.parameters)),
    );

    const phonePrompt = buildPhoneSystemPrompt(ctx, "en", "+17780000000");
    const compactChars = phonePrompt.length + JSON.stringify(phoneTools).length;
    expect(compactChars).toBeLessThan(18_000);
  });

  it("routes explicit human requests and unsupported phone tasks through a protected handoff", () => {
    const prompt = buildPhoneSystemPrompt(ctx, "en", "+17780000000");
    const transfer = (PHONE_REALTIME_TOOLS as Array<{
      name: string;
      description?: string;
      parameters?: { required?: string[] };
    }>).find((tool) => tool.name === "transfer_to_human");

    expect(prompt).toContain("caller explicitly asks for a person, manager, or staff member");
    expect(prompt).toContain("something unrelated such as arranging a ride");
    expect(prompt).toContain("ask permission to transfer");
    expect(prompt).toContain("Never transfer an emergency");
    expect(transfer?.description).toContain("server uses the owner's protected setting");
    expect(transfer?.parameters?.required).toEqual(["reason"]);
  });
});

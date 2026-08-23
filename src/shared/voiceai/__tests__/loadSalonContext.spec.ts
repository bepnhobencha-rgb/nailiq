import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import { loadSalonContext } from "../loadSalonContext";

type QueryResult = {
  data: unknown;
  error: unknown;
};

function orderedQuery(result: QueryResult) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    order: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.order.mockResolvedValue(result);
  return query;
}

function salonQuery(result: QueryResult) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.single.mockResolvedValue(result);
  return query;
}

function serviceRoleClient({
  servicesResult = {
    data: [
      {
        id: "service-1",
        name: "Gel Manicure",
        duration_minutes: 45,
        price_cents: 4_500,
        price_type: "fixed",
        price_max_cents: null,
        description: " Long-lasting colour ",
        category: "manicure",
        is_addon: false,
        is_popular: true,
        is_featured: false,
      },
    ],
    error: null,
  },
}: {
  servicesResult?: QueryResult;
} = {}) {
  const salon = salonQuery({
    data: {
      id: "salon-1",
      name: "QA Salon",
      timezone: "America/Vancouver",
      address: null,
      currency_code: "CAD",
      opening_hours: {},
      voice_ai_persona_name: "Lily",
      voice_ai_persona_voice: "marin",
      voice_ai_reasoning_effort: "low",
      voice_ai_upsell_enabled: true,
      voice_ai_allowed_languages: ["en", "vi"],
    },
    error: null,
  });
  const services = orderedQuery(servicesResult);
  const staff = orderedQuery({
    data: [{ id: "staff-1", name: "John" }],
    error: null,
  });
  const from = vi.fn((table: string) => {
    if (table === "salons") return salon;
    if (table === "services") return services;
    if (table === "staff") return staff;
    throw new Error(`Unexpected table: ${table}`);
  });

  mocks.createServiceRoleClient.mockReturnValue({ from });
  return { services };
}

describe("loadSalonContext", () => {
  beforeEach(() => {
    mocks.createServiceRoleClient.mockReset();
  });

  it("loads the canonical non-deleted service menu without an unsupported active flag", async () => {
    const mock = serviceRoleClient();

    const context = await loadSalonContext("voice-menu-canonical-filter");

    expect(mock.services.eq).toHaveBeenCalledTimes(1);
    expect(mock.services.eq).toHaveBeenCalledWith("salon_id", "salon-1");
    expect(mock.services.is).toHaveBeenCalledWith("deleted_at", null);
    expect(context?.services).toEqual([
      expect.objectContaining({
        id: "service-1",
        name: "Gel Manicure",
        description: "Long-lasting colour",
      }),
    ]);
  });

  it("surfaces a service read failure instead of returning an empty voice menu", async () => {
    serviceRoleClient({
      servicesResult: {
        data: null,
        error: { code: "42703", message: "column does not exist" },
      },
    });

    await expect(loadSalonContext("voice-menu-read-failure")).rejects.toThrow(
      "voice_context_services_unavailable",
    );
  });
});

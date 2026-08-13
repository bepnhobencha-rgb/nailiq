import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
  loadPublicNailTryOnSalon: vi.fn(),
  membershipMaybeSingle: vi.fn(),
  designSelectIs: vi.fn(),
  mappingSelectEq: vi.fn(),
  publishUpdate: vi.fn(),
  publishEq: vi.fn(),
  publishIn: vi.fn(),
  publishIs: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/nailTryOn/publicSalon", () => ({
  loadPublicNailTryOnSalon: mocks.loadPublicNailTryOnSalon,
}));

import { PATCH } from "./route";

const salonId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

function request(
  body: Record<string, unknown>,
  origin = "https://www.nailiq.ca",
) {
  return new Request("https://www.nailiq.ca/api/dashboard/nail-designs", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

function design(id: string, description = `Description ${id}`) {
  return { id, name: `Design ${id}`, description };
}

function mapping(designId: string) {
  return { design_id: designId, mapping_type: "service", is_default: true };
}

describe("Nail design catalog publication API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: userId } } }) },
    });
    mocks.loadPublicNailTryOnSalon.mockResolvedValue({ id: salonId });
    mocks.membershipMaybeSingle.mockResolvedValue({ data: { role: "owner" } });
    mocks.publishIs.mockResolvedValue({ error: null });
    mocks.publishIn.mockReturnValue({ is: mocks.publishIs });
    mocks.publishEq.mockReturnValue({ in: mocks.publishIn });
    mocks.publishUpdate.mockReturnValue({ eq: mocks.publishEq });

    const membershipTable = {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({ maybeSingle: mocks.membershipMaybeSingle })),
        })),
      })),
    };
    const designsTable = {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ is: mocks.designSelectIs })),
      })),
      update: mocks.publishUpdate,
    };
    const mappingsTable = {
      select: vi.fn(() => ({ eq: mocks.mappingSelectEq })),
    };
    mocks.createServiceRoleClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "salon_members") return membershipTable;
        if (table === "nail_designs") return designsTable;
        if (table === "nail_design_service_mappings") return mappingsTable;
        throw new Error(`Unexpected table: ${table}`);
      }),
    });
  });

  it("rejects cross-origin publication before authentication", async () => {
    const response = await PATCH(request(
      { slug: "qa-salon", action: "publish_catalog" },
      "https://attacker.example",
    ));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "invalid_origin" });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("keeps the catalog private when any publication requirement is missing", async () => {
    const ids = ["1", "2", "3", "4"];
    mocks.designSelectIs.mockResolvedValue({
      data: ids.map((id) => design(id)),
      error: null,
    });
    mocks.mappingSelectEq.mockResolvedValue({
      data: ids.map((id) => mapping(id)),
      error: null,
    });

    const response = await PATCH(request({
      slug: "qa-salon",
      action: "publish_catalog",
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "catalog_not_ready",
      assessment: { ready: false, designCount: 4, minimumDesignCount: 5 },
    });
    expect(mocks.publishUpdate).not.toHaveBeenCalled();
  });

  it("publishes the complete owner-reviewed catalog in one server mutation", async () => {
    const ids = ["1", "2", "3", "4", "5"];
    mocks.designSelectIs.mockResolvedValue({
      data: ids.map((id) => design(id)),
      error: null,
    });
    mocks.mappingSelectEq.mockResolvedValue({
      data: ids.map((id) => mapping(id)),
      error: null,
    });

    const response = await PATCH(request({
      slug: "qa-salon",
      action: "publish_catalog",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      publishedCount: 5,
    });
    expect(mocks.publishUpdate).toHaveBeenCalledWith(expect.objectContaining({
      is_active: true,
    }));
    expect(mocks.publishIn).toHaveBeenCalledWith("id", ids);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceRole = vi.hoisted(() => {
  const from = vi.fn();
  const rpc = vi.fn();
  const create = vi.fn(() => ({ from, rpc }));
  return { create, from, rpc };
});

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: serviceRole.create,
}));

import { GET, POST } from "./route";

describe("disabled /api/quick-rebook boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a generic 410 for GET without constructing privileged database access", async () => {
    const response = await GET();

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ ok: false, error: "gone" });
    expect(serviceRole.create).not.toHaveBeenCalled();
    expect(serviceRole.from).not.toHaveBeenCalled();
    expect(serviceRole.rpc).not.toHaveBeenCalled();
  });

  it("returns a generic 410 for POST without parsing PII or mutating a booking", async () => {
    const response = await POST();

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ ok: false, error: "gone" });
    expect(serviceRole.create).not.toHaveBeenCalled();
    expect(serviceRole.from).not.toHaveBeenCalled();
    expect(serviceRole.rpc).not.toHaveBeenCalled();
  });
});

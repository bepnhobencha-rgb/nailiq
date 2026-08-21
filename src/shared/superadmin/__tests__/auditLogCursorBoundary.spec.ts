import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireActive: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/shared/auth/requireActiveSuperAdminSession", () => ({
  requireActiveSuperAdminSession: mocks.requireActive,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import { loadSuperadminAuditLogs } from "../auditLogActions";

function cursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("SuperAdmin audit cursor boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActive.mockResolvedValue({
      ok: true,
      user: { id: "operator" },
      role: "founder",
      supabase: {},
    });
  });

  it.each([
    cursor({
      createdAt: "2026-08-20T12:00:00Z,action.eq.secret",
      id: "11111111-1111-4111-8111-111111111111",
    }),
    cursor({
      createdAt: "2026-08-20T12:00:00Z",
      id: "11111111-1111-4111-8111-111111111111),actor_role.eq.founder",
    }),
    cursor({
      createdAt: "not-a-date",
      id: "11111111-1111-4111-8111-111111111111",
    }),
    "not+base64/grammar",
  ])("rejects malformed or filter-grammar cursor material before service role", async (raw) => {
    await expect(loadSuperadminAuditLogs({}, raw)).resolves.toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });
});

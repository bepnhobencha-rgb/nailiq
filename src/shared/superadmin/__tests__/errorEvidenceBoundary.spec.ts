import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
  getSuperAdminRole: vi.fn(),
  selectedColumns: "",
}));

vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

vi.mock("@/shared/lib/superadmin", () => ({
  getSuperAdminRole: mocks.getSuperAdminRole,
}));

import { ErrorMonitorClient } from "@/components/superadmin/ErrorMonitorClient";
import {
  loadErrorLogs,
  type ErrorLogRow,
} from "@/shared/superadmin/errorMonitorActions";

const evidenceRow: ErrorLogRow = {
  id: "00000000-0000-4000-8000-000000000001",
  level: "error",
  message: "Hydration failed",
  surface: "client",
  route: "/choose-salon",
  salon_id: null,
  occurrence_count: 2,
  first_seen_at: "2026-07-28T14:00:00.000Z",
  last_seen_at: "2026-07-28T14:01:00.000Z",
  status: "open",
  ai_summary: null,
  ai_suggested_fix: null,
  fix_proposal: null,
  fix_file: null,
  fix_pr_url: null,
  stack: "Error: Hydration failed\n    at ChooseSalonClient",
  context: {
    href: "https://www.nailiq.ca/choose-salon",
    ua: "Evidence Browser",
  },
};

describe("superadmin error evidence boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectedColumns = "";
  });

  it("does not access service-role error evidence for an unauthenticated user", async () => {
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    });

    await expect(loadErrorLogs("open")).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("loads stack and context only after the superadmin gate", async () => {
    mocks.createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "founder-user" } },
        }),
      },
    });
    mocks.getSuperAdminRole.mockResolvedValue("founder");
    mocks.createServiceRoleClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn((columns: string) => {
          mocks.selectedColumns = columns;
          return {
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({
                  data: [evidenceRow],
                  error: null,
                }),
              }),
            }),
          };
        }),
      }),
    });

    await expect(loadErrorLogs("open")).resolves.toEqual({
      ok: true,
      rows: [evidenceRow],
    });
    expect(mocks.getSuperAdminRole).toHaveBeenCalledWith("founder-user");
    expect(mocks.selectedColumns).toContain("stack");
    expect(mocks.selectedColumns).toContain("context");
  });

  it("renders stored evidence in a collapsed technical section", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorMonitorClient, { initialRows: [evidenceRow] }),
    );

    expect(html).toContain("<details");
    expect(html).toContain("Technical evidence");
    expect(html).toContain("ChooseSalonClient");
    expect(html).toContain("Evidence Browser");
  });
});

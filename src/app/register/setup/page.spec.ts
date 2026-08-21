import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  redirect: vi.fn((destination: string): never => {
    throw { kind: "redirect", destination };
  }),
  notFound: vi.fn((): never => {
    throw { kind: "not_found" };
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  notFound: mocks.notFound,
}));

vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("@/shared/lib/demoOtpMode", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/shared/lib/demoOtpMode")
  >();
  return { ...original, isDemoOtpRuntime: () => false };
});

vi.mock("./RegisterSetupInner", () => ({
  default: vi.fn(() => null),
}));

import RegisterSetupPage from "./page";

type MembershipRow = { salon_id: string; role: string | null };

function pageClient({
  memberships,
  salon,
}: {
  memberships: MembershipRow[];
  salon?: {
    slug: string;
    name: string;
    timezone: string;
    setup_wizard_completed_at: string | null;
  };
}) {
  const from = vi.fn((table: string) => {
    if (table === "salon_members") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: memberships, error: null }),
        })),
      };
    }
    if (table === "salons") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: salon ?? null,
              error: null,
            }),
          })),
        })),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-1" } },
      }),
    },
    from,
  };
}

describe("RegisterSetupPage authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes an ambiguous multi-salon account to an explicit picker", async () => {
    mocks.createClient.mockResolvedValue(
      pageClient({
        memberships: [
          { salon_id: "salon-1", role: "owner" },
          { salon_id: "salon-2", role: "owner" },
        ],
      }),
    );

    await expect(RegisterSetupPage()).rejects.toMatchObject({
      kind: "redirect",
      destination: "/choose-salon",
    });
  });

  it("forbids a non-owner from the registration setup surface", async () => {
    mocks.createClient.mockResolvedValue(
      pageClient({
        memberships: [{ salon_id: "salon-1", role: "admin" }],
      }),
    );

    await expect(RegisterSetupPage()).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("redirects a completed owner salon without rendering the form", async () => {
    mocks.createClient.mockResolvedValue(
      pageClient({
        memberships: [{ salon_id: "salon-1", role: "owner" }],
        salon: {
          slug: "owner-salon",
          name: "Owner Salon",
          timezone: "America/Vancouver",
          setup_wizard_completed_at: "2026-08-19T00:00:00.000Z",
        },
      }),
    );

    await expect(RegisterSetupPage()).rejects.toMatchObject({
      kind: "redirect",
      destination: "/dashboard/owner-salon",
    });
  });

  it("prefills only an incomplete sole-owner salon", async () => {
    mocks.createClient.mockResolvedValue(
      pageClient({
        memberships: [{ salon_id: "salon-1", role: "owner" }],
        salon: {
          slug: "owner-salon",
          name: "Owner Salon",
          timezone: "America/Vancouver",
          setup_wizard_completed_at: null,
        },
      }),
    );

    const element = (await RegisterSetupPage()) as ReactElement<{
      isDemoMode: boolean;
      initial: unknown;
    }>;
    expect(element.props).toEqual({
      isDemoMode: false,
      initial: {
        mode: "rename",
        currentSlug: "owner-salon",
        name: "Owner Salon",
        timezone: "America/Vancouver",
      },
    });
  });
});

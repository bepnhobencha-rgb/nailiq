import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attributeRecentAudit: vi.fn(),
  getDashboardWriteClient: vi.fn(),
}));

vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.getDashboardWriteClient,
}));
vi.mock("@/shared/dashboard/attributeAudit", () => ({
  attributeRecentAudit: mocks.attributeRecentAudit,
}));

import { saveGuidedBookingPolicy } from "../guidedBookingPolicyAction";

type Capture = {
  table?: string;
  patch?: Record<string, unknown>;
  filters: Array<[string, unknown]>;
};

function updateClient(capture: Capture, row: unknown = { id: "salon-1" }) {
  const query = {
    update(patch: Record<string, unknown>) {
      capture.patch = patch;
      return this;
    },
    eq(column: string, value: unknown) {
      capture.filters.push([column, value]);
      return this;
    },
    select() {
      return this;
    },
    maybeSingle() {
      return Promise.resolve({ data: row, error: null });
    },
  };
  return {
    from: vi.fn((table: string) => {
      capture.table = table;
      return query;
    }),
  };
}

function context(
  role: "owner" | "admin" | "senior" | "receptionist" | "nail_tech",
  supabase: ReturnType<typeof updateClient>,
) {
  return {
    role,
    kind: "member",
    userId: "user-1",
    salon: { id: "salon-1", name: "QA Salon", slug: "qa-salon" },
    supabase,
  };
}

describe("saveGuidedBookingPolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.attributeRecentAudit.mockResolvedValue(undefined);
  });

  it.each(["owner", "admin"] as const)(
    "allows a same-salon %s to save only readiness policy fields",
    async (role) => {
      const capture: Capture = { filters: [] };
      const supabase = updateClient(capture);
      mocks.getDashboardWriteClient.mockResolvedValue(context(role, supabase));

      await expect(
        saveGuidedBookingPolicy("qa-salon", {
          en: "  English policy  ",
          vi: "  Chính sách tiếng Việt  ",
          groupTogetherThresholdMinutes: 15,
          noShowGroupWholeParty: true,
        }),
      ).resolves.toEqual({ ok: true });

      expect(capture).toEqual({
        table: "salons",
        patch: {
          cancellation_policy: {
            en: "English policy",
            vi: "Chính sách tiếng Việt",
          },
          group_together_threshold_minutes: 15,
          noshow_group_whole_party: true,
        },
        filters: [
          ["id", "salon-1"],
          ["slug", "qa-salon"],
        ],
      });
      expect(mocks.attributeRecentAudit).toHaveBeenCalledWith(
        "salon-1",
        ["salons"],
        "user-1",
      );
    },
  );

  it.each([
    { name: "senior", role: "senior" },
    { name: "receptionist", role: "receptionist" },
    { name: "nail technician", role: "nail_tech" },
  ] as const)("rejects a $name before any write", async ({ role }) => {
    const capture: Capture = { filters: [] };
    const supabase = updateClient(capture);
    mocks.getDashboardWriteClient.mockResolvedValue(context(role, supabase));

    await expect(
      saveGuidedBookingPolicy("qa-salon", { en: "English", vi: "Tiếng Việt" }),
    ).resolves.toEqual({ ok: false, error: "unauthorized" });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(mocks.attributeRecentAudit).not.toHaveBeenCalled();
  });

  it.each(["foreign member", "anonymous visitor"])(
    "rejects a %s before any write",
    async () => {
      mocks.getDashboardWriteClient.mockResolvedValue(null);

      await expect(
        saveGuidedBookingPolicy("qa-salon", {
          en: "English",
          vi: "Tiếng Việt",
        }),
      ).resolves.toEqual({ ok: false, error: "unauthorized" });
      expect(mocks.attributeRecentAudit).not.toHaveBeenCalled();
    },
  );

  it("rejects missing policy data and invalid group rules before writing", async () => {
    const capture: Capture = { filters: [] };
    const supabase = updateClient(capture);
    mocks.getDashboardWriteClient.mockResolvedValue(context("owner", supabase));

    await expect(
      saveGuidedBookingPolicy("qa-salon", { en: "", vi: "Tiếng Việt" }),
    ).resolves.toEqual({ ok: false, error: "policy_languages_required" });
    await expect(
      saveGuidedBookingPolicy("qa-salon", {
        en: "Cancel before [24 hours]",
        vi: "Huỷ trước 24 giờ",
      }),
    ).resolves.toEqual({ ok: false, error: "policy_placeholders_remaining" });
    await expect(
      saveGuidedBookingPolicy("qa-salon", {
        en: "English",
        vi: "Tiếng Việt",
        groupTogetherThresholdMinutes: 121,
        noShowGroupWholeParty: true,
      }),
    ).resolves.toEqual({ ok: false, error: "invalid_group_together_window" });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("contains no money, outbound, or provider integration dependency", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/shared/noshow/guidedBookingPolicyAction.ts",
      ),
      "utf8",
    );

    expect(source).toContain('.from("salons")');
    for (const forbidden of [
      "receptionistActions",
      "noShowDashboardActions",
      "stripeConnectActions",
      "square_integrations",
      "chargeNoShowFee",
      "sendNoShowFeeLink",
      "waiveNoShowFee",
      "payment_provider",
      "reminders_enabled",
      "waitlist_auto_book",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

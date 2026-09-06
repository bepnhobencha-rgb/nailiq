import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
  isDemoOtpRuntime: vi.fn(),
  pickAvailableSalonSlug: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

vi.mock("@/shared/register/salonSlugPicker", () => ({
  pickAvailableSalonSlug: mocks.pickAvailableSalonSlug,
}));

vi.mock("@/shared/register/demoSalonOwner", () => ({
  getOrCreateDemoSalonOwnerUserId: vi.fn(),
}));

vi.mock("@/shared/lib/demoOtpMode", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/shared/lib/demoOtpMode")
  >();
  return { ...original, isDemoOtpRuntime: mocks.isDemoOtpRuntime };
});

import { completeSalonRegistration } from "@/shared/register/completeSalonRegistrationAction";

type MembershipRow = { salon_id: string; role: string | null };
type ExistingSalonRow = {
  id: string;
  slug: string;
  setup_wizard_completed_at: string | null;
};

function authenticatedClient({
  memberships = [],
  membershipError = null,
  salon = null,
  salonError = null,
}: {
  memberships?: MembershipRow[];
  membershipError?: { message: string } | null;
  salon?: ExistingSalonRow | null;
  salonError?: { message: string } | null;
}) {
  const membershipEq = vi.fn().mockResolvedValue({
    data: memberships,
    error: membershipError,
  });
  const salonMaybeSingle = vi.fn().mockResolvedValue({
    data: salon,
    error: salonError,
  });
  const from = vi.fn((table: string) => {
    if (table === "salon_members") {
      return {
        select: vi.fn(() => ({ eq: membershipEq })),
      };
    }
    if (table === "salons") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ maybeSingle: salonMaybeSingle })),
        })),
      };
    }
    throw new Error(`unexpected authenticated table: ${table}`);
  });

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-1" } },
        error: null,
      }),
    },
    from,
    membershipEq,
    salonMaybeSingle,
  };
}

function existingOwnerAdminRpc(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  mocks.createServiceRoleClient.mockReturnValue({ rpc });
  return rpc;
}

function newOwnerRegistrationAdmin(slug: string) {
  const salonInsert = vi.fn(() => ({
    select: vi.fn(() => ({
      single: vi.fn().mockResolvedValue({
        data: { id: "salon-new", slug },
        error: null,
      }),
    })),
  }));
  const insert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn((table: string) => {
    if (table === "salons") return { insert: salonInsert };
    if (["services", "staff", "salon_members"].includes(table)) {
      return { insert };
    }
    throw new Error(`unexpected registration table: ${table}`);
  });
  const admin = { from };
  mocks.createServiceRoleClient.mockReturnValue(admin);
  return { client: admin, salonInsert };
}

describe("completeSalonRegistration existing-owner authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDemoOtpRuntime.mockReturnValue(false);
    mocks.pickAvailableSalonSlug.mockResolvedValue({
      slug: "owner-salon",
      slugAdjusted: false,
    });
  });

  it("keeps an authenticated owner on the real slug path when demo OTP is enabled", async () => {
    mocks.isDemoOtpRuntime.mockReturnValue(true);
    mocks.createClient.mockResolvedValue(
      authenticatedClient({ memberships: [] }),
    );
    mocks.pickAvailableSalonSlug.mockResolvedValue({
      slug: "nailiq-preview-qa",
      slugAdjusted: false,
    });
    const admin = newOwnerRegistrationAdmin("nailiq-preview-qa");

    await expect(
      completeSalonRegistration("NailIQ Preview QA", null, {
        slug: "nailiq-preview-qa",
        timezone: "America/Vancouver",
      }),
    ).resolves.toEqual({
      ok: true,
      slug: "nailiq-preview-qa",
      slugAdjusted: false,
    });
    expect(mocks.pickAvailableSalonSlug).toHaveBeenCalledWith(
      admin.client,
      "nailiq-preview-qa",
    );
    expect(admin.salonInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "nailiq-preview-qa",
        reminders_enabled: false,
        reminder_24h_enabled: false,
        reminder_3h_enabled: false,
        sms_reminders_enabled: false,
        profile_complete: false,
        sms_outbound_enabled: false,
        email_outbound_enabled: false,
        email_links_enabled: false,
        voice_ai_enabled: false,
        noshow_protection_enabled: false,
        winback_enabled: false,
        payment_provider: null,
        feature_flags: expect.objectContaining({
          coco_setup_activation_version: 1,
        }),
      }),
    );
  });

  it("fails closed when the canonical membership lookup errors", async () => {
    mocks.createClient.mockResolvedValue(
      authenticatedClient({
        membershipError: { message: "membership unavailable" },
      }),
    );

    await expect(completeSalonRegistration("Owner Salon")).resolves.toEqual({
      ok: false,
      error: "server_error",
      message: "membership unavailable",
    });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("forbids a non-owner membership before any service-role access", async () => {
    mocks.createClient.mockResolvedValue(
      authenticatedClient({
        memberships: [{ salon_id: "salon-1", role: "admin" }],
      }),
    );

    await expect(completeSalonRegistration("Owner Salon")).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("fails an ambiguous multi-salon account without falling through to create", async () => {
    const client = authenticatedClient({
      memberships: [
        { salon_id: "salon-1", role: "owner" },
        { salon_id: "salon-2", role: "owner" },
      ],
    });
    mocks.createClient.mockResolvedValue(client);

    await expect(completeSalonRegistration("Owner Salon")).resolves.toEqual({
      ok: false,
      error: "ambiguous_membership",
    });
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("treats a completed owner salon as a mutation-free server no-op", async () => {
    mocks.createClient.mockResolvedValue(
      authenticatedClient({
        memberships: [{ salon_id: "salon-1", role: "owner" }],
        salon: {
          id: "salon-1",
          slug: "owner-salon",
          setup_wizard_completed_at: "2026-08-19T00:00:00.000Z",
        },
      }),
    );

    await expect(
      completeSalonRegistration("Attempted Rename", null, {
        slug: "attempted-rename",
        timezone: "America/Toronto",
      }),
    ).resolves.toEqual({
      ok: true,
      slug: "owner-salon",
      slugAdjusted: false,
    });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("completes an incomplete sole-owner salon only through the atomic RPC", async () => {
    mocks.createClient.mockResolvedValue(
      authenticatedClient({
        memberships: [{ salon_id: "salon-1", role: "owner" }],
        salon: {
          id: "salon-1",
          slug: "owner-salon",
          setup_wizard_completed_at: null,
        },
      }),
    );
    const rpc = existingOwnerAdminRpc({
      success: true,
      code: "updated",
      slug: "owner-salon",
    });

    await expect(
      completeSalonRegistration("Renamed Salon", null, {
        slug: "owner-salon",
        timezone: "America/Toronto",
      }),
    ).resolves.toEqual({
      ok: true,
      slug: "owner-salon",
      slugAdjusted: false,
    });
    expect(rpc).toHaveBeenCalledWith(
      "complete_existing_owner_registration_setup",
      {
        p_salon_id: "salon-1",
        p_actor_user_id: "user-1",
        p_name: "Renamed Salon",
        p_slug: "owner-salon",
        p_timezone: "America/Toronto",
      },
    );
  });

  it("propagates an atomic membership-race denial instead of creating", async () => {
    mocks.createClient.mockResolvedValue(
      authenticatedClient({
        memberships: [{ salon_id: "salon-1", role: "owner" }],
        salon: {
          id: "salon-1",
          slug: "owner-salon",
          setup_wizard_completed_at: null,
        },
      }),
    );
    existingOwnerAdminRpc({
      success: false,
      code: "ambiguous_membership",
    });

    await expect(completeSalonRegistration("Renamed Salon")).resolves.toEqual({
      ok: false,
      error: "ambiguous_membership",
    });
    expect(mocks.createServiceRoleClient).toHaveBeenCalledTimes(1);
  });

  it("maps an atomic owner-role recheck failure to unauthorized", async () => {
    mocks.createClient.mockResolvedValue(
      authenticatedClient({
        memberships: [{ salon_id: "salon-1", role: "owner" }],
        salon: {
          id: "salon-1",
          slug: "owner-salon",
          setup_wizard_completed_at: null,
        },
      }),
    );
    existingOwnerAdminRpc({ success: false, code: "forbidden" });

    await expect(completeSalonRegistration("Renamed Salon")).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
  });
});

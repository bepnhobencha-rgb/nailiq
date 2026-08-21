import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
  getDashboardWriteClient: vi.fn(),
  addStaff: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.getDashboardWriteClient,
  addStaff: mocks.addStaff,
}));

import { loadTeamAccessMap } from "@/shared/dashboard/staffAccess";

type CallerRole = "owner" | "admin" | "senior" | "receptionist" | "nail_tech";

type Scenario = {
  role?: CallerRole;
  user?: { id: string } | null;
  authError?: { message: string } | null;
  membershipError?: { message: string } | null;
  salon?: { id: string; slug: string } | null;
  salonError?: { message: string } | null;
  staffRows?: Array<{ user_id: string | null }>;
  staffError?: { message: string } | null;
  linkedMembers?: Array<{ user_id: string; role: string }>;
  linkedMembersError?: { message: string } | null;
  authUsers?: Record<
    string,
    | {
        user: {
          id: string;
          email?: string | null;
          phone?: string | null;
          email_confirmed_at?: string | null;
          phone_confirmed_at?: string | null;
          last_sign_in_at?: string | null;
        };
        error?: null;
      }
    | { user: null; error: { message: string } }
  >;
};

function installScenario(input: Scenario = {}) {
  const role = input.role ?? "owner";
  const user = input.user === undefined ? { id: "caller-user" } : input.user;
  const memberships = user
    ? [{ salon_id: "salon-1", role }]
    : [];
  const salon = input.salon === undefined
    ? { id: "salon-1", slug: "owner-salon" }
    : input.salon;
  const staffRows = input.staffRows ?? [{ user_id: "linked-user" }];

  const membershipEq = vi.fn().mockResolvedValue({
    data: memberships,
    error: input.membershipError ?? null,
  });
  const salonMaybeSingle = vi.fn().mockResolvedValue({
    data: salon,
    error: input.salonError ?? null,
  });
  const salonIn = vi.fn().mockReturnValue({ maybeSingle: salonMaybeSingle });
  const salonEq = vi.fn().mockReturnValue({ in: salonIn });
  const staffIs = vi.fn().mockResolvedValue({
    data: staffRows,
    error: input.staffError ?? null,
  });
  const staffEq = vi.fn().mockReturnValue({ is: staffIs });

  const getUser = vi.fn().mockResolvedValue({
    data: { user },
    error: input.authError ?? null,
  });
  const serverFrom = vi.fn((table: string) => {
    if (table === "salon_members") {
      return {
        select: vi.fn().mockReturnValue({ eq: membershipEq }),
      };
    }
    if (table === "salons") {
      return {
        select: vi.fn().mockReturnValue({ eq: salonEq }),
      };
    }
    if (table === "staff") {
      return {
        select: vi.fn().mockReturnValue({ eq: staffEq }),
      };
    }
    throw new Error(`Unexpected server table: ${table}`);
  });
  const serverClient = {
    auth: { getUser },
    rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    from: serverFrom,
  };
  mocks.createClient.mockResolvedValue(serverClient);

  const linkedMembers = input.linkedMembers ?? [
    { user_id: "linked-user", role: "receptionist" },
  ];
  const linkedMembersIn = vi.fn().mockResolvedValue({
    data: linkedMembers,
    error: input.linkedMembersError ?? null,
  });
  const linkedMembersEq = vi.fn().mockReturnValue({ in: linkedMembersIn });
  const getUserById = vi.fn(async (userId: string) => {
    const configured = input.authUsers?.[userId];
    if (configured) {
      return {
        data: { user: configured.user },
        error: configured.error ?? null,
      };
    }
    return {
      data: {
        user: {
          id: userId,
          email: `${userId}@example.test`,
          phone: "+16045550123",
          email_confirmed_at: "2026-08-19T12:00:00.000Z",
          phone_confirmed_at: null,
          last_sign_in_at: null,
        },
      },
      error: null,
    };
  });
  const serviceFrom = vi.fn((table: string) => {
    if (table !== "salon_members") {
      throw new Error(`Unexpected service table: ${table}`);
    }
    return {
      select: vi.fn().mockReturnValue({ eq: linkedMembersEq }),
    };
  });
  const serviceClient = {
    from: serviceFrom,
    auth: { admin: { getUserById } },
  };
  mocks.createServiceRoleClient.mockReturnValue(serviceClient);

  return {
    getUser,
    serverFrom,
    membershipEq,
    salonEq,
    salonIn,
    salonMaybeSingle,
    staffEq,
    staffIs,
    linkedMembersEq,
    linkedMembersIn,
    getUserById,
  };
}

describe("loadTeamAccessMap authorization boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an invalid slug before Auth or service-role access", async () => {
    await expect(loadTeamAccessMap("../other-salon")).resolves.toEqual({
      ok: false,
      error: "invalid_slug",
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("rejects an anonymous caller without touching service role", async () => {
    installScenario({ user: null });

    await expect(loadTeamAccessMap("owner-salon")).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("fails closed on a Supabase Auth verification error", async () => {
    installScenario({ authError: { message: "auth unavailable" } });

    await expect(loadTeamAccessMap("owner-salon")).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase Auth rejects instead of returning an error", async () => {
    const spies = installScenario();
    spies.getUser.mockRejectedValueOnce(new Error("network unavailable"));

    await expect(loadTeamAccessMap("owner-salon")).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("rejects a foreign salon slug without touching service role", async () => {
    const spies = installScenario({ salon: null });

    await expect(loadTeamAccessMap("foreign-salon")).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(spies.salonEq).toHaveBeenCalledWith("slug", "foreign-salon");
    expect(spies.salonIn).toHaveBeenCalledWith("id", ["salon-1"]);
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it.each<CallerRole>(["senior", "receptionist", "nail_tech"])(
    "forbids the %s role before privileged access",
    async (role) => {
      installScenario({ role });

      await expect(loadTeamAccessMap("owner-salon")).resolves.toEqual({
        ok: false,
        error: "forbidden",
      });
      expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    },
  );

  it("allows an owner and returns only canonical linked-user PII", async () => {
    const spies = installScenario({
      role: "owner",
      staffRows: [
        { user_id: "linked-user" },
        { user_id: "linked-user" },
        { user_id: null },
      ],
    });

    await expect(loadTeamAccessMap("owner-salon")).resolves.toEqual({
      ok: true,
      accessMap: {
        "linked-user": {
          role: "receptionist",
          email: "linked-user@example.test",
          phone: "+16045550123",
          active: true,
        },
      },
    });
    expect(spies.membershipEq).toHaveBeenCalledWith("user_id", "caller-user");
    expect(spies.staffEq).toHaveBeenCalledWith("salon_id", "salon-1");
    expect(spies.linkedMembersEq).toHaveBeenCalledWith("salon_id", "salon-1");
    expect(spies.linkedMembersIn).toHaveBeenCalledWith("user_id", ["linked-user"]);
    expect(spies.getUserById).toHaveBeenCalledWith("linked-user");
    expect(spies.getUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createServiceRoleClient.mock.invocationCallOrder[0],
    );
    expect(spies.staffIs.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createServiceRoleClient.mock.invocationCallOrder[0],
    );
  });

  it("allows an admin to read team access for their own salon", async () => {
    installScenario({ role: "admin" });

    const result = await loadTeamAccessMap("owner-salon");

    expect(result.ok).toBe(true);
    expect(mocks.createServiceRoleClient).toHaveBeenCalledTimes(1);
  });

  it("ignores extra caller-supplied IDs and derives linked IDs from staff", async () => {
    const spies = installScenario({
      role: "owner",
      staffRows: [{ user_id: "canonical-user" }],
      linkedMembers: [{ user_id: "canonical-user", role: "admin" }],
    });
    const unsafeDirectCall = loadTeamAccessMap as unknown as (
      ...args: unknown[]
    ) => ReturnType<typeof loadTeamAccessMap>;

    const result = await unsafeDirectCall("owner-salon", [
      "foreign-user",
      "wrong-user-id",
    ]);

    expect(result).toEqual({
      ok: true,
      accessMap: {
        "canonical-user": {
          role: "admin",
          email: "canonical-user@example.test",
          phone: "+16045550123",
          active: true,
        },
      },
    });
    expect(spies.linkedMembersIn).toHaveBeenCalledWith("user_id", [
      "canonical-user",
    ]);
    expect(spies.getUserById).toHaveBeenCalledTimes(1);
    expect(spies.getUserById).toHaveBeenCalledWith("canonical-user");
  });

  it("fails closed when the canonical staff query fails", async () => {
    installScenario({ staffError: { message: "staff read failed" } });

    await expect(loadTeamAccessMap("owner-salon")).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns an empty map without service role when no staff login is linked", async () => {
    installScenario({ staffRows: [{ user_id: null }] });

    await expect(loadTeamAccessMap("owner-salon")).resolves.toEqual({
      ok: true,
      accessMap: {},
    });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("fails closed when the linked-membership query fails", async () => {
    const spies = installScenario({
      linkedMembersError: { message: "membership read failed" },
    });

    await expect(loadTeamAccessMap("owner-salon")).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    expect(spies.getUserById).not.toHaveBeenCalled();
  });

  it("fails closed instead of returning partial PII when Auth lookup fails", async () => {
    installScenario({
      staffRows: [{ user_id: "good-user" }, { user_id: "broken-user" }],
      linkedMembers: [
        { user_id: "good-user", role: "receptionist" },
        { user_id: "broken-user", role: "admin" },
      ],
      authUsers: {
        "broken-user": {
          user: null,
          error: { message: "Auth user missing" },
        },
      },
    });

    await expect(loadTeamAccessMap("owner-salon")).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
  });
});

import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  redirect: vi.fn((destination: string): never => {
    throw { kind: "redirect", destination };
  }),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/components/auth/ChooseSalonClient", () => ({
  ChooseSalonClient: () => null,
}));
import ChooseSalonPage from "./page";

type Member = { salon_id: string | null; role: string | null };
const members: Member[] = [
  { salon_id: "salon-1", role: "owner" },
  { salon_id: "salon-2", role: "receptionist" },
];
const salons = [
  { id: "salon-1", slug: "e2e-one", name: "E2E One" },
  { id: "salon-2", slug: "e2e-two", name: "E2E Two" },
];
const unavailable = { code: "PGRST000", message: "synthetic read failure" };

function client(options: {
  authenticated?: boolean;
  members?: Member[] | null;
  salons?: typeof salons | null;
  memberError?: typeof unavailable;
  salonError?: typeof unavailable;
} = {}) {
  const order = vi.fn().mockResolvedValue({
    data: options.members === undefined ? members : options.members,
    error: options.memberError ?? null,
  });
  const inIds = vi.fn().mockResolvedValue({
    data: options.salons === undefined ? salons : options.salons,
    error: options.salonError ?? null,
  });
  const eq = vi.fn(() => ({ order }));
  const from = vi.fn((table: string) => {
    if (table === "salon_members") return { select: vi.fn(() => ({ eq })) };
    if (table === "salons") return { select: vi.fn(() => ({ in: inIds })) };
    throw new Error(`Unexpected table: ${table}`);
  });
  const result = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: {
          user: options.authenticated === false ? null : { id: "user-1" },
        },
      }),
      signOut: vi.fn(),
    },
    from,
  };
  mocks.createClient.mockResolvedValue(result);
  return { ...result, eq, inIds };
}

describe("ChooseSalonPage access and read recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  for (const stage of ["member", "salon"] as const) {
    for (const partial of [false, true]) {
      it(`${stage} error with ${partial ? "partial" : "no"} data keeps a retryable page without salon links`, async () => {
        const c = client(stage === "member"
          ? { members: partial ? members : null, memberError: unavailable }
          : { salons: partial ? salons : null, salonError: unavailable });
        const page = await ChooseSalonPage() as ReactElement<{
          cards: unknown[];
          unavailable: boolean;
        }>;
        expect(page.props).toMatchObject({ cards: [], unavailable: true });
        expect(mocks.redirect).not.toHaveBeenCalled();
        expect(c.auth.signOut).not.toHaveBeenCalled();
        if (stage === "member") expect(c.inIds).not.toHaveBeenCalled();
      });
    }
  }
  it("requires authentication before reading memberships", async () => {
    const c = client({ authenticated: false });
    await expect(ChooseSalonPage()).rejects.toMatchObject({ destination: "/login" });
    expect(c.from).not.toHaveBeenCalled();
  });
  it.each([{ members: [] }, { members: [{ salon_id: null, role: "owner" }] }])("keeps setup routing for no valid memberships: %j", async options => {
    client(options);
    await expect(ChooseSalonPage()).rejects.toMatchObject({
      destination: "/register/setup",
    });
  });
  it("keeps setup routing when no salon can be resolved", async () => {
    client({ salons: [] });
    await expect(ChooseSalonPage()).rejects.toMatchObject({
      destination: "/register/setup",
    });
  });
  it.each(["owner", "admin", "senior", "nail_tech", "receptionist", "UNKNOWN", null])("keeps least-privilege routing for single membership %s", async role => {
    client({ members: [{ salon_id: "salon-1", role }] });
    await expect(ChooseSalonPage()).rejects.toMatchObject({
      destination: `/dashboard/e2e-one${role === "owner" || role === "admin" ? "" : "/center"}`,
    });
  });
  it("queries only the authenticated user's salon IDs and returns correctly routed cards", async () => {
    const c = client();
    const page = await ChooseSalonPage() as ReactElement<{ cards: unknown[] }>;
    expect(c.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(c.inIds).toHaveBeenCalledWith("id", ["salon-1", "salon-2"]);
    expect(page.props.cards).toEqual([
      {
        salonId: "salon-1", slug: "e2e-one", name: "E2E One",
        role: "owner", href: "/dashboard/e2e-one",
      },
      {
        salonId: "salon-2", slug: "e2e-two", name: "E2E Two",
        role: "receptionist", href: "/dashboard/e2e-two/center",
      },
    ]);
  });
});

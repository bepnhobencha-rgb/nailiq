import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), write: vi.fn(), stripe: vi.fn(), db: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/dashboard/salonOwnerActions", () => ({ resolveSalonForDashboard: mocks.resolve }));
vi.mock("@/shared/dashboard/setupActions", () => ({ getDashboardWriteClient: mocks.write }));
vi.mock("@/shared/lib/stripe", () => ({ getStripeClient: mocks.stripe, getStripeReturnOrigin: () => "https://qa.example" }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.db }));
import { createCheckoutSession, createCustomerPortalSession } from "../stripeActions";
import { startStripeConnectOnboarding, refreshStripeConnectStatus } from "../stripeConnectActions";

const actions = [
  ["subscription checkout", () => createCheckoutSession("e2e-billing-a", "pro")],
  ["subscription portal", () => createCustomerPortalSession("e2e-billing-a")],
  ["Connect onboarding", () => startStripeConnectOnboarding("e2e-billing-a")],
  ["Connect refresh", () => refreshStripeConnectStatus("e2e-billing-a")],
] as const;

describe("billing actions enforce authority before provider access", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.stripe.mockImplementation(() => { throw new Error("Unexpected provider access"); });
    mocks.db.mockImplementation(() => { throw new Error("Unexpected privileged DB access"); });
  });
  for (const role of ["admin", "senior", "receptionist", "nail_tech", "unknown"]) {
    it.each(actions)(`${role} cannot invoke %s`, async (_label, action) => {
      const ctx = { role, salon: { id: "salon-a" }, viewerUserId: "qa-user" };
      mocks.resolve.mockResolvedValue(ctx); mocks.write.mockResolvedValue(ctx);
      expect(await action()).toEqual({ ok: false, error: "forbidden" });
      expect(mocks.stripe).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
    });
  }
  it.each(actions)("unresolved membership/session cannot invoke %s", async (_label, action) => {
    mocks.resolve.mockResolvedValue(null); mocks.write.mockResolvedValue(null);
    expect(await action()).toEqual({ ok: false, error: "unauthorized" });
    expect(mocks.stripe).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
  });
  it.each(actions.slice(0, 2))("V1 blocks owner %s before Stripe or DB, using the real release predicate", async (_label, action) => {
    mocks.resolve.mockResolvedValue({ role: "owner", salon: { id: "salon-a" }, viewerUserId: "qa-owner" });
    expect(await action()).toEqual({ ok: false, error: "phase_2_not_available" });
    expect(mocks.stripe).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
  });
  it.each(actions.slice(2))("owner %s with no configured provider returns a typed failure without DB mutation", async (_label, action) => {
    mocks.write.mockResolvedValue({ role: "owner", salon: { id: "salon-a" } }); mocks.stripe.mockReturnValue(null);
    expect(await action()).toEqual({ ok: false, error: "stripe_not_configured" });
    expect(mocks.db).not.toHaveBeenCalled();
  });
});

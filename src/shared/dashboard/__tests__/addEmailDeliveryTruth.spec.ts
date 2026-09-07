import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  resolveSalonForDashboard: vi.fn(),
  sendEmailVerification: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/shared/dashboard/salonOwnerActions", () => ({
  resolveSalonForDashboard: mocks.resolveSalonForDashboard,
}));
vi.mock("@/shared/dashboard/sendEmailVerification", () => ({
  sendEmailVerification: mocks.sendEmailVerification,
}));

import { addSalonEmail } from "@/shared/dashboard/addEmailAction";

class UpdateQuery implements PromiseLike<{ error: { message: string } | null }> {
  constructor(private readonly error: { message: string } | null) {}

  update(): this {
    return this;
  }

  eq(): this {
    return this;
  }

  then<TResult1 = { error: { message: string } | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({ error: this.error }).then(onfulfilled, onrejected);
  }
}

describe("salon email verification delivery truth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSalonForDashboard.mockResolvedValue({
      kind: "member",
      role: "owner",
      salon: { id: "salon-1", name: "QA Salon", email: null },
    });
    mocks.createClient.mockResolvedValue({
      from: () => new UpdateQuery(null),
    });
  });

  it("reports sent only after the verification sender succeeds", async () => {
    mocks.sendEmailVerification.mockResolvedValue({ ok: true, token: "token" });

    await expect(addSalonEmail("qa-salon", "owner@example.com")).resolves.toEqual({
      ok: true,
      verificationDelivery: "sent",
    });
  });

  it("keeps the saved email but reports unavailable when no message was sent", async () => {
    mocks.sendEmailVerification.mockResolvedValue({ ok: false, reason: "no_client" });

    await expect(addSalonEmail("qa-salon", "owner@example.com")).resolves.toEqual({
      ok: true,
      verificationDelivery: "unavailable",
    });
  });

  it("does not crash the dashboard when the verification sender throws", async () => {
    mocks.sendEmailVerification.mockRejectedValue(new Error("provider missing"));

    await expect(addSalonEmail("qa-salon", "owner@example.com")).resolves.toEqual({
      ok: true,
      verificationDelivery: "unavailable",
    });
  });

  it("does not call the sender when the email save fails", async () => {
    mocks.createClient.mockResolvedValue({
      from: () => new UpdateQuery({ message: "save failed" }),
    });

    await expect(addSalonEmail("qa-salon", "owner@example.com")).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    expect(mocks.sendEmailVerification).not.toHaveBeenCalled();
  });
});

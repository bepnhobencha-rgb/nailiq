import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let throwOnClientCreation = false;
let suppressionResult: {
  data: { email: string } | null;
  error: { message: string } | null;
} = { data: null, error: null };

const maybeSingle = vi.fn(async () => suppressionResult);

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => {
    if (throwOnClientCreation) throw new Error("service role unavailable");
    return {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle }),
        }),
      }),
    };
  },
}));

import { isEmailSuppressed } from "../emailCompliance";

describe("isEmailSuppressed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    throwOnClientCreation = false;
    suppressionResult = { data: null, error: null };
  });

  it("does not query or suppress a blank address", async () => {
    await expect(isEmailSuppressed("  ")).resolves.toBe(false);
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("suppresses an address present in the opt-out table", async () => {
    suppressionResult = {
      data: { email: "client@example.com" },
      error: null,
    };

    await expect(
      isEmailSuppressed(" CLIENT@example.com "),
    ).resolves.toBe(true);
  });

  it("allows optional mail only after a successful negative lookup", async () => {
    await expect(
      isEmailSuppressed("client@example.com"),
    ).resolves.toBe(false);
  });

  it("fails closed when Supabase returns an error", async () => {
    suppressionResult = {
      data: null,
      error: { message: "database unavailable" },
    };

    await expect(
      isEmailSuppressed("client@example.com"),
    ).resolves.toBe(true);
  });

  it("fails closed when the service-role client throws", async () => {
    throwOnClientCreation = true;

    await expect(
      isEmailSuppressed("client@example.com"),
    ).resolves.toBe(true);
  });
});
